from flask import Flask, request, Response
import requests

app = Flask(__name__)

@app.route('/api/proxy')
def proxy():
    query = request.args.get('q')
    if not query:
        return "Ready. Usage: /api/proxy?q=searchterm", 200

    url = f"https://html.duckduckgo.com/html/?q={query}"
    headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    
    try:
        res = requests.get(url, headers=headers, timeout=10)
        content = res.text
        
        # Rewrite links so results are clickable
        content = content.replace('href="/html', 'href="https://html.duckduckgo.com/html')
        content = content.replace('src="/', 'src="https://duckduckgo.com/')

        response = Response(content, mimetype='text/html')
        # Allow the about:blank tab to show this content
        response.headers['Content-Security-Policy'] = "frame-ancestors *"
        response.headers['X-Frame-Options'] = "ALLOWALL"
        return response
    except Exception as e:
        return f"Error: {str(e)}", 500
