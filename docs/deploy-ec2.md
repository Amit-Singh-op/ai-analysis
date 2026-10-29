# Deploying to AWS EC2

Everything runs on one instance with Docker Compose: the app, PostgreSQL and Ollama. Every question is planned by the local model, so the instance size decides how fast answers are.

## 1. Pick an instance

| Setup | Instance | Answer time |
|---|---|---|
| CPU only, `llama3.2:3b` | `c7i.xlarge` (4 vCPU, 8 GB) or bigger | ~5–15 s per question |
| GPU, `qwen2.5:7b` (recommended) | `g5.xlarge` (NVIDIA A10G, 24 GB) | ~1 s per question, noticeably more accurate |

- **OS:** Ubuntu 24.04 LTS or Amazon Linux 2023
- **Disk:** 30 GB gp3 (more if you load millions of telemetry rows)
- **Security group:** allow inbound **22** (SSH, your IP only) and **80/443** (if behind a reverse proxy) or **3000**. **Never open 5432 or 11434.** The compose file doesn't publish them.

## 2. Install Docker

```bash
# Ubuntu
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER && newgrp docker
```

## 3. Get the code and configure

```bash
git clone <your-repo-url> local-ai-analyst && cd local-ai-analyst
cp .env.example .env
```

Edit `.env` and set **strong, different** passwords:

```bash
POSTGRES_ADMIN_PASSWORD=<long-random-string>
POSTGRES_PASSWORD=<another-long-random-string>   # read-only app user
```

(`openssl rand -base64 24` makes a good password.)

## 4. Start the stack

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

First-time database setup (schema, read-only role, demo data):

```bash
docker compose -f docker-compose.prod.yml exec app npm run db:schema
docker compose -f docker-compose.prod.yml exec app npm run db:seed      # demo data only, skip for real data
```

Check it:

```bash
curl http://localhost:3000/health
```

Then open `http://<ec2-public-ip>:3000`.

## 5. Ollama (required)

Every question is planned by the local model, so Ollama must be running:

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml exec ollama ollama pull llama3.2:3b
```

Set `PLANNER_MODEL` in `.env` if you pull a different model. On a GPU instance a 7–8B model (e.g. `qwen2.5:7b`) is faster and more accurate.

## 6. HTTPS (recommended)

Put Caddy in front for automatic HTTPS. Point a domain at the instance, then:

```bash
sudo apt-get install -y caddy
echo 'analyst.example.com { reverse_proxy 127.0.0.1:3000 }' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Then close port 3000 in the security group and set `APP_PORT=127.0.0.1:3000` in `.env`, so the app is only reachable through Caddy.

## 7. Teaching the model in production

Use **Not right?** under an answer in the chat. Corrections are saved to `data/plan-examples.json` (mounted from the host, so they survive rebuilds; commit it to git to keep them). See [training.md](training.md).

## 8. Updating

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec app npm test
```

## 9. Backups

```bash
docker compose -f docker-compose.prod.yml exec postgres pg_dump -U analyst_admin telemetry_db | gzip > backup-$(date +%F).sql.gz
```

Copy backups and `logs/` to S3 (`aws s3 cp ...`) on a daily cron.
