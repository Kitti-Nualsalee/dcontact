#!/usr/bin/env python3
"""เสิร์ฟ mockups/ แบบไม่ให้เบราว์เซอร์แคช

python -m http.server ไม่ส่ง cache header ทำให้เบราว์เซอร์แคช app.css / app.js เอง
แล้วคนแก้ไฟล์ก็เห็นของเก่าจนกว่าจะ hard refresh — เสียเวลาและหลอกให้คิดว่าโค้ดพัง
ใช้แทน: python3 mockups/serve.py [port]   (ค่าเริ่มต้น 8090)
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, test


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    test(HandlerClass=partial(NoCacheHandler, directory='mockups'), port=port, bind='127.0.0.1')
