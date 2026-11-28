import pytest

from proxy import check_url, is_public

PUBLIC = {"example.com": ["93.184.216.34"], "github.com": ["140.82.112.3"],
          "evil.example": ["10.1.2.3"], "mixed.example": ["93.184.216.34", "127.0.0.1"],
          "mapped.example": ["::ffff:127.0.0.1"]}


def stub(host):
    return PUBLIC.get(host, [])


@pytest.mark.parametrize("url", [
    "http://example.com/",            # not https
    "https://n8n:5678/",              # single-label Docker name
    "https://postgres/",
    "https://localhost/",
    "https://10.0.0.1/",              # IP literals
    "https://[::1]/",
    "https://host.docker.internal/",
    "https://evil.example/",          # resolves to a private address
    "https://mixed.example/",         # one of its addresses is loopback
    "https://mapped.example/",        # IPv4-mapped loopback
    "https://unknown.example/",       # does not resolve
    "ftp://example.com/",
    "https://example.com:99999/",
])
def test_refused(url):
    assert check_url(url, resolve=stub) is not None


def test_allowed():
    assert check_url("https://github.com/owner/repo", resolve=stub) is None


@pytest.mark.parametrize("addr,ok", [
    ("93.184.216.34", True), ("127.0.0.1", False), ("10.0.0.1", False), ("172.16.0.1", False),
    ("192.168.1.1", False), ("169.254.169.254", False), ("100.64.0.1", False), ("0.0.0.0", False),
    ("::1", False), ("fe80::1", False), ("fd00::1", False), ("224.0.0.1", False), ("not-an-ip", False),
    ("64:ff9b::7f00:1", False), ("64:ff9b::a9fe:a9fe", False), ("64:ff9b::5db8:d822", True),  # NAT64
    ("64:ff9b:1::a00:1", False),
])
def test_is_public(addr, ok):
    assert is_public(addr) is ok


@pytest.mark.parametrize("url", ["http://kokoro:8880/v1/audio/voices", "https://127.0.0.1/", "https://n8n:5678/"])
def test_clip_download_refuses_internal_hops(url):
    import httpx
    import mix
    import visuals
    with pytest.raises(mix.RenderError):
        visuals.check_hop(httpx.Request("GET", url))
