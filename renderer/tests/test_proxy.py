import asyncio

import proxy


class Rebinder:
    """Public address on the first lookup, loopback on every later one."""
    def __init__(self):
        self.calls = 0

    def __call__(self, host):
        self.calls += 1
        return ["93.184.216.34"] if self.calls == 1 else ["127.0.0.1"]


async def _request(port, raw: bytes) -> bytes:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(raw)
    await writer.drain()
    reply = await reader.read(200)
    writer.close()
    return reply


def run_proxy(resolver, raws):
    connected = []

    async def connect(addr, port):
        connected.append((addr, port))
        raise ConnectionRefusedError  # nothing real is reached in the test

    async def main():
        server = await proxy.serve("127.0.0.1", 0, proxy.Proxy(resolve=resolver, connect=connect))
        port = server.sockets[0].getsockname()[1]
        try:
            return [await _request(port, raw) for raw in raws]
        finally:
            server.close()

    return asyncio.run(main()), connected


def test_rebinding_never_reaches_loopback():
    replies, connected = run_proxy(Rebinder(), [
        b"CONNECT rebind.example:443 HTTP/1.1\r\nHost: rebind.example:443\r\n\r\n",
        b"CONNECT rebind.example:443 HTTP/1.1\r\nHost: rebind.example:443\r\n\r\n",
    ])
    # The first lookup was public: the proxy connected to exactly that address.
    assert connected == [("93.184.216.34", 443)]
    assert replies[0].startswith(b"HTTP/1.1 502")
    # The second lookup rebinds to loopback: refused, nothing connected.
    assert replies[1].startswith(b"HTTP/1.1 403")


def test_refuses_loopback_private_and_other_ports():
    hosts = {"example.com": ["93.184.216.34"], "postgres": ["172.18.0.2"]}
    replies, connected = run_proxy(lambda h: hosts.get(h, []), [
        b"GET http://127.0.0.1:8000/health HTTP/1.1\r\nHost: 127.0.0.1:8000\r\n\r\n",
        b"CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n",
        b"GET http://postgres/ HTTP/1.1\r\n\r\n",          # private address
        b"GET http://postgres:5432/ HTTP/1.1\r\n\r\n",     # port
        b"CONNECT example.com:22 HTTP/1.1\r\n\r\n",
        b"CONNECT host.docker.internal:443 HTTP/1.1\r\n\r\n",
        b"GET /relative HTTP/1.1\r\n\r\n",
    ])
    assert all(r.startswith(b"HTTP/1.1 403") for r in replies), replies
    assert connected == []
