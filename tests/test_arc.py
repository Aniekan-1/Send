import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from requests import HTTPError
from web3 import Web3

from dollardrop.arc import rpc_provider


@pytest.fixture
def throttled_rpc():
    """A JSON-RPC server that answers 429 a few times before answering properly."""
    state = {"throttle": 0, "calls": 0}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state["calls"] += 1
            if state["throttle"]:
                state["throttle"] -= 1
                self.send_response(429)
                self.end_headers()
                return
            body = json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": "0x2a"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}", state
    server.shutdown()


def test_reads_ride_out_rate_limiting(throttled_rpc):
    url, state = throttled_rpc
    state["throttle"] = 2
    assert Web3(rpc_provider(url)).eth.block_number == 42
    assert state["calls"] == 3


def test_sends_ride_out_rate_limiting_too(throttled_rpc):
    # Safe to resend: a 429 means the node never took it, and a signed tx's nonce lets it land only once.
    url, state = throttled_rpc
    state["throttle"] = 1
    Web3(rpc_provider(url)).eth.send_raw_transaction(b"\x01")
    assert state["calls"] == 2


def test_gives_up_eventually(throttled_rpc):
    url, state = throttled_rpc
    state["throttle"] = 100
    with pytest.raises(HTTPError):
        Web3(rpc_provider(url)).eth.block_number
    assert state["calls"] == 6
