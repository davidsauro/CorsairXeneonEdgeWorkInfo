#!/usr/bin/env python3
"""
Dual-stack static server for widget preview.

Two reasons this is not just `python -m http.server`:

1. `--bind 0.0.0.0` listens on IPv4 only. Windows resolves "localhost" to the IPv6
   loopback first, and that is the address WSL forwards, so a browser on Windows cannot
   reach an IPv4-only server in WSL by name.
2. Serving over http://<ip> is not a secure context, so `navigator.clipboard` is
   undefined and the widget's COPY button cannot work. http://localhost *is* a secure
   context, which matches the file:// origin iCUE actually uses.
"""
import functools
import http.server
import os
import socket
import sys


class DualStackServer(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6
    daemon_threads = True

    def server_bind(self):
        # Accept IPv4 connections on the same socket.
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except OSError:
            pass
        super().server_bind()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    root = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
    with DualStackServer(("::", port), handler) as httpd:
        print(f"serving {root} on port {port} (IPv4 + IPv6)", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
