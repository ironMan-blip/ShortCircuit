"""A page's script must not reach the renderer's own API on loopback (docs/PLAN.md §5)."""
import asyncio
import http.server
import threading

import pytest

import proxy
import visuals

playwright = pytest.importorskip("playwright.sync_api")


class Stub(http.server.BaseHTTPRequestHandler):
    hits: list[str] = []

    def _hit(self):
        Stub.hits.append(f"{self.command} {self.path}")
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(b"{}")

    do_GET = do_POST = _hit

    def log_message(self, *a):
        pass


PAGE = """<script>
window.done = Promise.allSettled([
  fetch('http://127.0.0.1:%(port)d/health', {mode: 'no-cors'}),
  fetch('http://127.0.0.1:%(port)d/cache/prune', {method: 'POST', mode: 'no-cors'}),
]);
</script>"""


@pytest.fixture
def stub_api():
    """Stands in for the renderer's API on 127.0.0.1."""
    Stub.hits = []
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server.server_address[1]
    server.shutdown()


@pytest.fixture
def proxy_port():
    loop = asyncio.new_event_loop()
    server = loop.run_until_complete(proxy.serve("127.0.0.1", 0))
    threading.Thread(target=loop.run_forever, daemon=True).start()
    yield server.sockets[0].getsockname()[1]
    loop.call_soon_threadsafe(server.close)
    loop.call_soon_threadsafe(loop.stop)


def visit(browser, port):
    page = browser.new_page()
    page.set_content(PAGE % {"port": port})
    page.evaluate("window.done")
    page.close()


def test_page_script_cannot_reach_loopback(stub_api, proxy_port):
    with playwright.sync_playwright() as p:
        # Control: without the proxy flags the same page does reach the stub, so the test can fail.
        plain = p.chromium.launch(chromium_sandbox=True)
        visit(plain, stub_api)
        plain.close()
        assert sorted(Stub.hits) == ["GET /health", "POST /cache/prune"]

        Stub.hits = []
        browser = visuals.launch(p, proxy_port)
        visit(browser, stub_api)
        browser.close()
    assert Stub.hits == []
