import os
bind = f"0.0.0.0:{os.environ.get('PORT', '8000')}"
workers = int(os.environ.get("WEB_CONCURRENCY", 1))   # the model is ~160 MB per worker
threads = int(os.environ.get("THREADS", 4))
timeout = 120
preload_app = True
