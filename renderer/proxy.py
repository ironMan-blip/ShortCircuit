"""Checking HTTP proxy and URL check (docs/PLAN.md §5, step 3).

Trust boundary: every url here comes from web text or model output. The proxy resolves
each hostname once, checks every address, and connects to the address it checked, so a
DNS rebind (public address for the check, private one for the connection) cannot get in.
Chromium (screenshots) and n8n (source fetches) both send all traffic through it.
"""
import asyncio
import ipaddress
import logging
import socket
from urllib.parse import urlsplit

log = logging.getLogger("proxy")

PORT = 8899
ALLOWED_PORTS = {80, 443}
MAX_BYTES = 20 * 1024 * 1024
MAX_SECONDS = 60
REFUSED = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
BAD_GATEWAY = b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"


def resolve(host: str) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError):
        return []
    return list(dict.fromkeys(info[4][0] for info in infos))


def is_public(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr.split("%")[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def public_addrs(host: str, resolve=resolve) -> list[str]:
    """All addresses of host, or [] if any of them is not public."""
    addrs = resolve(host)
    return addrs if addrs and all(is_public(a) for a in addrs) else []


def check_url(url: str, resolve=resolve) -> str | None:
    """None if url may be opened by the renderer, else the reason it is refused."""
    try:
        parts = urlsplit(url)
        host = parts.hostname
        parts.port  # raises on a bad port
    except ValueError:
        return "unparseable url"
    if parts.scheme != "https":
        return "not https"
    if not host or "." not in host.strip("."):
        return "hostname has no dot"
    try:
        ipaddress.ip_address(host)
        return "ip literal"
    except ValueError:
        pass
    if host == "host.docker.internal":
        return "docker host name"
    if not public_addrs(host, resolve):
        return "hostname does not resolve only to public addresses"
    return None


class Proxy:
    def __init__(self, resolve=resolve, connect=asyncio.open_connection):
        self.resolve = resolve
        self.connect = connect

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            async with asyncio.timeout(MAX_SECONDS):
                await self._handle(reader, writer)
        except Exception as e:  # a broken client connection must never stop the server
            log.debug("connection ended: %r", e)
        finally:
            writer.close()

    async def _handle(self, reader, writer):
        head = await reader.readuntil(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        method, target, _version = lines[0].split(" ", 2)
        if method == "CONNECT":
            host, _, port = target.rpartition(":")
            host, port = host.strip("[]"), int(port)
        else:
            url = urlsplit(target)
            if url.scheme != "http" or not url.hostname:
                return await self._refuse(writer, target, "bad request target")
            host, port = url.hostname, url.port or 80
        if port not in ALLOWED_PORTS:
            return await self._refuse(writer, target, "port")
        addrs = await asyncio.to_thread(public_addrs, host, self.resolve)
        if not addrs:
            return await self._refuse(writer, target, "not a public address")
        try:
            up_reader, up_writer = await self.connect(addrs[0], port)
        except OSError:
            writer.write(BAD_GATEWAY)
            return await writer.drain()
        try:
            if method == "CONNECT":
                writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                await writer.drain()
            else:
                path = url.path or "/"
                if url.query:
                    path += "?" + url.query
                headers = [h for h in lines[1:] if h and not h.lower().startswith(("proxy-", "connection:"))]
                up_writer.write(("\r\n".join([f"{method} {path} HTTP/1.1", *headers, "Connection: close"])
                                 + "\r\n\r\n").encode("latin-1"))
            await _relay(reader, writer, up_reader, up_writer)
        finally:
            up_writer.close()

    async def _refuse(self, writer, target, reason):
        log.warning("refused %s: %s", target, reason)
        writer.write(REFUSED)
        await writer.drain()


async def _relay(c_reader, c_writer, u_reader, u_writer):
    budget = [MAX_BYTES]

    async def pipe(src, dst):
        try:
            while data := await src.read(65536):
                budget[0] -= len(data)
                if budget[0] < 0:
                    return
                dst.write(data)
                await dst.drain()
        except OSError:  # either side hung up: the tunnel is over
            return

    tasks = [asyncio.create_task(pipe(c_reader, u_writer)), asyncio.create_task(pipe(u_reader, c_writer))]
    _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()


async def serve(host="0.0.0.0", port=PORT, proxy: Proxy | None = None) -> asyncio.Server:
    return await asyncio.start_server((proxy or Proxy()).handle, host, port)
