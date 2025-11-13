# Nexus Cloud Runner

Standalone cloud service that manages Discord bots and Minecraft servers for Nexus Hosting.

## Features

- Automatically starts/stops Discord bots and Minecraft servers
- Streams console logs to Supabase in real-time
- Executes commands sent from the web dashboard
- Auto-restarts crashed processes
- Supports multiple concurrent servers

## Deployment to Railway

### Option 1: Deploy from GitHub (Recommended)

1. Push the `cloud-runner` folder to a separate GitHub repository
2. In Railway, click "New Project" → "Deploy from GitHub repo"
3. Select your cloud-runner repository
4. Railway will automatically detect the Dockerfile and deploy

### Option 2: Deploy from CLI

\`\`\`bash
cd cloud-runner
npm install -g @railway/cli
railway login
railway init
railway up
\`\`\`

### Required Environment Variables

Add these in Railway's Variables tab:

\`\`\`
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
WORKSPACE_ROOT=/app/workspace
\`\`\`

## How It Works

1. **Polling**: Every 5 seconds, queries Supabase for servers with `status = 'running'`
2. **Starting**: Spawns Node.js processes for Discord bots or Java processes for Minecraft servers
3. **Logging**: Streams all console output to the `bot_logs` table in real-time
4. **Commands**: Checks for pending commands every 2 seconds and executes them
5. **Cleanup**: When a server's status changes to 'stopped', kills the process

## Server Types

### Discord Bots
- Reads bot files from `bot_files` table
- Writes files to `/app/workspace/bots/{server_id}/`
- Loads environment variables from `bot_environment_variables` table
- Spawns `node index.js` (or custom main file)

### Minecraft Servers
- Reads properties from `minecraft_properties` table
- Creates `server.properties` and `eula.txt` automatically
- Supports vanilla and Forge servers
- Spawns `java -jar server.jar nogui`

## Monitoring

View logs in Railway's deployment logs or query the `bot_logs` table:

\`\`\`sql
SELECT * FROM bot_logs 
WHERE server_id = 'your-server-id' 
ORDER BY timestamp DESC 
LIMIT 100;
\`\`\`

## Troubleshooting

**Servers not starting:**
- Check Railway logs for error messages
- Verify environment variables are set correctly
- Ensure Supabase credentials are valid

**Bot crashes immediately:**
- Check `bot_logs` table for error messages
- Verify bot token is correct in the `servers` table
- Ensure all required npm packages are listed in bot files

**Minecraft server fails:**
- Ensure Java 17 is available (included in Dockerfile)
- Verify `server.jar` exists or Forge is properly installed
- Check `minecraft_properties` table for valid configuration
