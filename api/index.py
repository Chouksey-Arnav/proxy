from flask import Flask, request, Response
import requests

app = Flask(__name__)

@app.route('/api/proxy')
def proxy_logic():
    query = request.args.get('q')
    if not query:
        return "No query provided. Use ?q=search", 400

    # DuckDuckGo HTML version (works best for proxies)
    target_url = f"https://html.duckduckgo.com/html/?q={query}"
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
    }

    try:
        response = requests.get(target_url, headers=headers, timeout=10)
        html_content = response.text

        # Rewrite relative links so clicking results works
        html_content = html_content.replace('href="/html', 'href="https://html.duckduckgo.com/html')
        html_content = html_content.replace('src="/', 'src="https://duckduckgo.com/')

        res = Response(html_content, mimetype='text/html')
        
        # SECURITY HEADERS: These allow the about:blank tab to show the content
        res.headers['Content-Security-Policy'] = "frame-ancestors *"
        res.headers['X-Frame-Options'] = "ALLOWALL"
        res.headers['Access-Control-Allow-Origin'] = "*"
        
        return res
    except Exception as e:
        return f"Proxy Error: {str(e)}", 500

# Vercel entry point
def handler(request):
    return app(request)
