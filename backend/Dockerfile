FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
RUN pip install --no-cache-dir requests
COPY analyzer.py .
CMD ["python", "analyzer.py"]
