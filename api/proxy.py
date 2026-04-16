from http.server import BaseHTTPRequestHandler
import requests
from urllib.parse import urlparse, parse_qs

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        query_params = parse_qs(urlparse(self.path).query)
        search_query = query_params.get('q', [None])[0]

        if not search_query:
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(b"No query provided. Usage: /api/proxy?q=searchterm")
            return

        url = f"https://html.duckduckgo.com/html/?q={search_query}"
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
        
        try:
            response = requests.get(url, headers=headers, timeout=10)
            # This fixes links so clicking results doesn't break the proxy
            content = response.text.replace('href="/html', 'href="https://html.duckduckgo.com/html')
            content = content.replace('src="/', 'src="https://duckduckgo.com/')

            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            # Critical: Allows the content to show up inside the about:blank iframe
            self.send_header('Content-Security-Policy', "frame-ancestors *")
            self.end_headers()
            self.wfile.write(content.encode('utf-8'))
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(f"Proxy Error: {str(e)}".encode())
