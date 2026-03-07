# -- Stage 1: Build frontend --
FROM node:20-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json ./
RUN npm install --production
COPY frontend/ ./
RUN npm run build

# -- Stage 2: Production image --
FROM python:3.11-slim
WORKDIR /app

# Install system deps for audio processing
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg libsndfile1 && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies (cache mount keeps downloads between builds)
COPY backend/requirements.txt ./
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --progress-bar on \
    torch --extra-index-url https://download.pytorch.org/whl/cpu && \
    pip install --progress-bar on -r requirements.txt

# Copy backend
COPY backend/ ./backend/

# Copy built frontend
COPY --from=frontend-build /app/frontend/build ./backend/static

# Create data directories
RUN mkdir -p /app/uploads /app/outputs

ENV UPLOAD_DIR=/app/uploads
ENV OUTPUT_DIR=/app/outputs
ENV PORT=5000

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--timeout", "600", "--workers", "2", "backend.app:app"]
