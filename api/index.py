from flask import Flask, request, Response
import requests

app = Flask(__name__)

@app.route('/api/proxy')
def proxy():
    query = request.args.get('q')
    if not query:
        return "No query provided. Append ?q=search to the URL.", 400

    # DuckDuckGo HTML endpoint
    url = f"https://html.duckduckgo.com/html/?q={query}"
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
    
    try:
        res = requests.get(url, headers=headers, timeout=10)
        content = res.text
        
        # FIXING LINKS: This ensures that when you click a result, it doesn't break
        content = content.replace('href="/html', 'href="https://html.duckduckgo.com/html')
        content = content.replace('src="/', 'src="https://duckduckgo.com/')
        
        # Create response and inject security headers to allow the about:blank iframe
        response = Response(content, mimetype='text/html')
        response.headers['Content-Security-Policy'] = "frame-ancestors *"
        response.headers['X-Frame-Options'] = "ALLOWALL"
        return response
    except Exception as e:
        return f"Proxy Error: {str(e)}", 500

# Vercel needs this
def handler(request):
    return app(request)
