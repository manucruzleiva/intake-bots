FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY bot.py .

# Provide DISCORD_TOKEN, GITHUB_TOKEN, GITHUB_REPO (and optionally GUILD_ID)
# as environment variables at runtime.
CMD ["python", "bot.py"]
