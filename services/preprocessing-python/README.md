# OpenCV Preprocessing Microservice (Python)

FastAPI service that performs deskew/denoise/binarization using native OpenCV and exchanges artifacts through MinIO. Results are delivered asynchronously via Redis pub/sub so Node workers remain free of OpenCV bindings.

## Running locally

```bash
cd services/preprocessing-python
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export MINIO_ENDPOINT=localhost
export MINIO_PORT=9000
export MINIO_ACCESS_KEY=minioadmin
export MINIO_SECRET_KEY=minioadmin
export PREPROCESSOR_REDIS_URL=redis://localhost:6379

uvicorn app:app --host 0.0.0.0 --port 8001 --reload
```

## API

- `POST /preprocess` — body:
  ```json
  {
    "requestId": "uuid",
    "sourceBucket": "documents",
    "sourceKey": "originals/<checksum>",
    "resultBucket": "documents",
    "resultKey": "preprocess/output/<uuid>.png",
    "callbackChannel": "preprocess:results",
    "traceId": "optional-trace"
  }
  ```
- Publishes a Redis message to `callbackChannel` containing `requestId`, `resultKey`, `bucket`, and `correctionAngleDeg` (or `error`).

