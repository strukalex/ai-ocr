import asyncio
import io
import json
import logging
import os
from typing import Tuple

import cv2
import numpy as np
import redis.asyncio as redis
from fastapi import FastAPI, HTTPException
from minio import Minio
from pydantic import BaseModel

LOG_LEVEL = os.getenv("PREPROCESSOR_LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=LOG_LEVEL)
logger = logging.getLogger("preprocessing-python")


class PreprocessRequest(BaseModel):
    requestId: str
    sourceBucket: str
    sourceKey: str
    resultBucket: str
    resultKey: str
    callbackChannel: str
    traceId: str | None = None


def build_minio_client() -> Minio:
    endpoint = os.getenv("MINIO_ENDPOINT", "localhost")
    port = os.getenv("MINIO_PORT", "9000")
    use_ssl = os.getenv("MINIO_USE_SSL", "false").lower() == "true"
    return Minio(
        f"{endpoint}:{port}",
        access_key=os.getenv("MINIO_ACCESS_KEY", "minioadmin"),
        secret_key=os.getenv("MINIO_SECRET_KEY", "minioadmin"),
        secure=use_ssl,
    )


redis_client = redis.from_url(
    os.getenv("PREPROCESSOR_REDIS_URL", os.getenv("REDIS_URL", "redis://localhost:6379"))
)
minio_client = build_minio_client()
app = FastAPI(title="OpenCV Preprocessing Service", version="0.1.0")


def _deskew(image: np.ndarray) -> Tuple[np.ndarray, float]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 50, 200)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=80, minLineLength=50, maxLineGap=10)

    if lines is None or len(lines) == 0:
        return image, 0.0

    angles = []
    for line in lines:
        x1, y1, x2, y2 = line[0]
        angle = np.degrees(np.arctan2(y2 - y1, x2 - x1))
        if abs(angle) > 0.5 and abs(angle) < 89:
            angles.append(angle)

    if not angles:
        return image, 0.0

    median_angle = float(np.median(angles))
    correction_angle = -median_angle
    if abs(correction_angle) < 0.5:
        return image, 0.0

    center = (image.shape[1] // 2, image.shape[0] // 2)
    matrix = cv2.getRotationMatrix2D(center, correction_angle, 1.0)
    rotated = cv2.warpAffine(
        image,
        matrix,
        (image.shape[1], image.shape[0]),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )
    return rotated, correction_angle


def _denoise(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return cv2.bilateralFilter(gray, 9, 75, 75)


def _binarize(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 35, 10)


def preprocess_image(raw: bytes) -> Tuple[bytes, float]:
    np_image = np.frombuffer(raw, dtype=np.uint8)
    decoded = cv2.imdecode(np_image, cv2.IMREAD_COLOR)
    if decoded is None:
        raise ValueError("Failed to decode image content")

    deskewed, angle = _deskew(decoded)
    denoised = _denoise(deskewed)
    binarized = _binarize(denoised)

    success, encoded = cv2.imencode(".png", binarized)
    if not success:
        raise ValueError("Failed to encode preprocessed image")

    return encoded.tobytes(), angle


async def publish_response(channel: str, payload: dict) -> None:
    await redis_client.publish(channel, json.dumps(payload))


def _fetch_object(bucket: str, key: str) -> bytes:
    response = minio_client.get_object(bucket, key)
    try:
        return response.read()
    finally:
        response.close()
        response.release_conn()


def _store_object(bucket: str, key: str, content: bytes, metadata: dict | None = None) -> None:
    metadata = metadata or {}
    found = minio_client.bucket_exists(bucket)
    if not found:
        minio_client.make_bucket(bucket)
    minio_client.put_object(
        bucket,
        key,
        io.BytesIO(content),
        length=len(content),
        content_type="image/png",
        metadata=metadata,
    )


async def process_and_respond(req: PreprocessRequest) -> None:
    try:
        raw = await asyncio.to_thread(_fetch_object, req.sourceBucket, req.sourceKey)
        processed, angle = await asyncio.to_thread(preprocess_image, raw)
        await asyncio.to_thread(
            _store_object,
            req.resultBucket,
            req.resultKey,
            processed,
            {
                "preprocess-request-id": req.requestId,
                "correction-angle-deg": str(angle),
                "source-key": req.sourceKey,
            },
        )
        await publish_response(
            req.callbackChannel,
            {
                "requestId": req.requestId,
                "resultKey": req.resultKey,
                "bucket": req.resultBucket,
                "correctionAngleDeg": angle,
                "traceId": req.traceId,
            },
        )
    except Exception as exc:  # pragma: no cover - defensive path
        logger.exception("preprocess.failed", extra={"requestId": req.requestId})
        await publish_response(
            req.callbackChannel,
            {"requestId": req.requestId, "error": str(exc), "traceId": req.traceId},
        )


@app.post("/preprocess")
async def preprocess(req: PreprocessRequest):
    """
    Accept a preprocessing job. Work is performed asynchronously and results are
    published to Redis with the processed object written to MinIO.
    """
    if not req.requestId:
        raise HTTPException(status_code=400, detail="requestId is required")

    asyncio.create_task(process_and_respond(req))
    return {"status": "accepted", "requestId": req.requestId}

