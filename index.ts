import { createClient } from "@supabase/supabase-js"
import { spawn, type ChildProcess } from "child_process"
import { mkdirSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import "dotenv/config"

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
)

// Track running processes
const runningProcesses = new Map<string, ChildProcess>()
const processLogs = new Map<string, string[]>()

console.log("[v0] Nexus Cloud Runner starting...")
console.log(
  "[v0] Supabase URL:",
  (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "NOT SET")?.substring(0, 30) + "...",
)
console.log("[v0] Service Role Key:", process.env.SUPABASE_SERVICE_ROLE_KEY ? "SET" : "NOT SET")

// Create workspace directories
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || "/app/workspace"
const BOT_WORKSPACE = join(WORKSPACE_ROOT, "bots")
const MINECRAFT_WORKSPACE = join(WORKSPACE_ROOT, "minecraft-servers")

mkdirSync(BOT_WORKSPACE, { recursive: true })
mkdirSync(MINECRAFT_WORKSPACE, { recursive: true })

console.log("[v0] Workspace directories created")
console.log(`[v0] Bot workspace: ${BOT_WORKSPACE}`)
console.log(`[v0] Minecraft workspace: ${MINECRAFT_WORKSPACE}`)

// Stream logs to Supabase
async function logToSupabase(serverId: string, message: string, logType = "info") {
  try {
    await supabase.from("bot_logs").insert({
      server_id: serverId,
      message,
      log_type: logType,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] Failed to log to Supabase:", error)
  }
}

// Update server status
async function updateServerStatus(serverId: string, status: string) {
  try {
    await supabase
      .from("servers")
      .update({
        status,
        updated_at: new Date().toISOString(),
      })
      .eq("id", serverId)
    console.log(`[v0] Updated server ${serverId} status to: ${status}`)
  } catch (error) {
    console.error("[v0] Failed to update server status:", error)
  }
}

// Start Discord bot
async function startDiscordBot(server: any) {
  const serverId = server.id
  const serverName = server.name

  console.log(`[v0] Starting Discord bot: ${serverName} (${serverId})`)

  // Create bot directory
  const botDir = join(BOT_WORKSPACE, serverId)
  mkdirSync(botDir, { recursive: true })

  // Fetch bot files from database
  const { data: files } = await supabase.from("bot_files").select("*").eq("server_id", serverId)

  if (!files || files.length === 0) {
    console.log(`[v0] No files found for bot ${serverName}, creating default bot`)
    await logToSupabase(serverId, "No bot files found, creating default bot", "warning")

    // Create default bot
    const defaultBot = `
import { Client, GatewayIntentBits } from 'discord.js';

const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ] 
});

client.on('ready', () => {
  console.log(\`Logged in as \${client.user.tag}!\`);
});

client.on('messageCreate', async (message) => {
  if (message.content === '!ping') {
    message.reply('Pong!');
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
`
    writeFileSync(join(botDir, "index.js"), defaultBot)
  } else {
    // Write all files to disk
    for (const file of files) {
      const filePath = join(botDir, file.file_path)
      const fileDir = join(filePath, "..")
      mkdirSync(fileDir, { recursive: true })
      writeFileSync(filePath, file.content)
      console.log(`[v0] Wrote file: ${file.file_path}`)
    }
  }

  // Fetch environment variables
  const { data: envVars } = await supabase.from("bot_environment_variables").select("*").eq("server_id", serverId)

  const env = { ...process.env }
  if (envVars) {
    for (const envVar of envVars) {
      env[envVar.key] = envVar.value
    }
  }

  // Add bot token
  if (server.bot_token) {
    env.DISCORD_BOT_TOKEN = server.bot_token
  }

  await logToSupabase(serverId, `Starting bot with ${files?.length || 0} files`, "info")

  // Determine main file
  const mainFile = server.main_file || "index.js"
  const mainFilePath = join(botDir, mainFile)

  if (!existsSync(mainFilePath)) {
    console.error(`[v0] Main file not found: ${mainFile}`)
    await logToSupabase(serverId, `Main file not found: ${mainFile}`, "error")
    await updateServerStatus(serverId, "error")
    return
  }

  // Start the bot process
  const botProcess = spawn("node", [mainFilePath], {
    cwd: botDir,
    env,
  })

  runningProcesses.set(serverId, botProcess)
  processLogs.set(serverId, [])

  botProcess.stdout.on("data", async (data) => {
    const message = data.toString()
    console.log(`[v0] [${serverName}] ${message}`)
    await logToSupabase(serverId, message, "info")

    const logs = processLogs.get(serverId) || []
    logs.push(message)
    if (logs.length > 100) logs.shift()
    processLogs.set(serverId, logs)
  })

  botProcess.stderr.on("data", async (data) => {
    const message = data.toString()
    console.error(`[v0] [${serverName}] ERROR: ${message}`)
    await logToSupabase(serverId, message, "error")
  })

  botProcess.on("exit", async (code) => {
    console.log(`[v0] Bot ${serverName} exited with code ${code}`)
    await logToSupabase(serverId, `Bot exited with code ${code}`, code === 0 ? "info" : "error")
    await updateServerStatus(serverId, "stopped")
    runningProcesses.delete(serverId)
    processLogs.delete(serverId)
  })

  await updateServerStatus(serverId, "running")
  await logToSupabase(serverId, "Bot started successfully", "info")
}

// Start Minecraft server
async function startMinecraftServer(server: any) {
  const serverId = server.id
  const serverName = server.name

  console.log(`[v0] Starting Minecraft server: ${serverName} (${serverId})`)

  const serverDir = join(MINECRAFT_WORKSPACE, serverId)
  mkdirSync(serverDir, { recursive: true })

  await logToSupabase(serverId, "Preparing Minecraft server...", "info")

  // Fetch server properties
  const { data: properties } = await supabase
    .from("minecraft_properties")
    .select("*")
    .eq("server_id", serverId)
    .single()

  const serverProps = properties || {}

  // Create server.properties
  const propsContent = `
# Minecraft server properties
server-port=${serverProps.port || 25565}
motd=${serverProps.motd || serverName}
gamemode=${serverProps.game_mode || "survival"}
difficulty=${serverProps.difficulty || "normal"}
max-players=${serverProps.max_players || 20}
pvp=${serverProps.pvp !== false}
online-mode=${serverProps.online_mode !== false}
allow-flight=${serverProps.allow_flight || false}
enable-command-block=${serverProps.enable_command_block || false}
spawn-protection=${serverProps.spawn_protection || 16}
view-distance=${serverProps.view_distance || 10}
`.trim()

  writeFileSync(join(serverDir, "server.properties"), propsContent)

  // Create eula.txt
  writeFileSync(join(serverDir, "eula.txt"), "eula=true")

  await logToSupabase(serverId, "Configuration files created", "info")

  // Determine server type
  const minecraftType = server.minecraft_type || "vanilla"
  const version = server.minecraft_version || "1.20.1"

  const serverJar = join(serverDir, "server.jar")
  let launchCommand = ["java", "-Xmx2048M", "-Xms1024M", "-jar", serverJar, "nogui"]

  // For Forge servers, check if installation exists
  if (minecraftType === "forge") {
    const forgeFiles = existsSync(join(serverDir, "libraries"))
    const runBat = join(serverDir, "run.sh")
    const runScript = existsSync(runBat)

    if (forgeFiles && runScript) {
      console.log(`[v0] Found existing Forge installation for ${serverName}`)
      await logToSupabase(serverId, "Using existing Forge installation", "info")
      launchCommand = ["bash", runBat]
    } else {
      await logToSupabase(serverId, "Forge not installed. Please install Forge manually first.", "error")
      await updateServerStatus(serverId, "error")
      return
    }
  } else {
    // Download vanilla server jar if needed
    if (!existsSync(serverJar)) {
      await logToSupabase(serverId, `Downloading Minecraft ${version}...`, "info")
      // In production, implement actual download logic here
      // For now, log that manual setup is needed
      await logToSupabase(serverId, "Server jar not found. Please upload server.jar manually.", "error")
      await updateServerStatus(serverId, "error")
      return
    }
  }

  // Start the Minecraft server
  const mcProcess = spawn(launchCommand[0], launchCommand.slice(1), {
    cwd: serverDir,
    env: process.env,
  })

  runningProcesses.set(serverId, mcProcess)
  processLogs.set(serverId, [])

  mcProcess.stdout.on("data", async (data) => {
    const message = data.toString()
    console.log(`[v0] [${serverName}] ${message}`)
    await logToSupabase(serverId, message, "info")

    const logs = processLogs.get(serverId) || []
    logs.push(message)
    if (logs.length > 100) logs.shift()
    processLogs.set(serverId, logs)
  })

  mcProcess.stderr.on("data", async (data) => {
    const message = data.toString()
    console.error(`[v0] [${serverName}] ERROR: ${message}`)
    await logToSupabase(serverId, message, "error")
  })

  mcProcess.on("exit", async (code) => {
    console.log(`[v0] Minecraft server ${serverName} exited with code ${code}`)
    await logToSupabase(serverId, `Server exited with code ${code}`, code === 0 ? "info" : "error")
    await updateServerStatus(serverId, "stopped")
    runningProcesses.delete(serverId)
    processLogs.delete(serverId)
  })

  await updateServerStatus(serverId, "running")
  await logToSupabase(serverId, "Minecraft server started successfully", "info")
}

// Stop a server
async function stopServer(serverId: string) {
  const process = runningProcesses.get(serverId)
  if (process) {
    console.log(`[v0] Stopping server: ${serverId}`)
    process.kill("SIGTERM")
    runningProcesses.delete(serverId)
    processLogs.delete(serverId)
    await updateServerStatus(serverId, "stopped")
  }
}

// Poll for servers
async function pollServers() {
  try {
    // Get all servers that should be running
    const { data: servers, error } = await supabase.from("servers").select("*").eq("status", "running")

    if (error) {
      console.error("[v0] Error fetching servers:", error)
      return
    }

    if (!servers || servers.length === 0) {
      return
    }

    console.log(`[v0] Found ${servers.length} server(s) that should be running`)

    for (const server of servers) {
      // Skip if already running
      if (runningProcesses.has(server.id)) {
        continue
      }

      console.log(`[v0] Server needs to start: ${server.name} (${server.type})`)

      if (server.type === "discord") {
        await startDiscordBot(server)
      } else if (server.type === "minecraft") {
        await startMinecraftServer(server)
      }
    }

    // Check for servers that should be stopped
    const runningIds = Array.from(runningProcesses.keys())
    for (const runningId of runningIds) {
      const serverStillRunning = servers.find((s: any) => s.id === runningId)
      if (!serverStillRunning) {
        console.log(`[v0] Server ${runningId} should no longer be running, stopping...`)
        await stopServer(runningId)
      }
    }
  } catch (error) {
    console.error("[v0] Error in pollServers:", error)
  }
}

// Check for command executions
async function checkCommands() {
  try {
    const { data: commands } = await supabase
      .from("server_commands")
      .select("*")
      .is("executed_at", null)
      .order("created_at", { ascending: true })
      .limit(10)

    if (!commands || commands.length === 0) {
      return
    }

    for (const cmd of commands) {
      const process = runningProcesses.get(cmd.server_id)
      if (process && process.stdin) {
        console.log(`[v0] Executing command for ${cmd.server_id}: ${cmd.command}`)
        process.stdin.write(cmd.command + "\n")

        await supabase.from("server_commands").update({ executed_at: new Date().toISOString() }).eq("id", cmd.id)
      }
    }
  } catch (error) {
    console.error("[v0] Error checking commands:", error)
  }
}

// Main loop
async function main() {
  console.log("[v0] Starting main polling loop...")

  // Initial poll
  await pollServers()

  // Poll every 5 seconds
  setInterval(pollServers, 5000)

  // Check commands every 2 seconds
  setInterval(checkCommands, 2000)

  console.log("[v0] Cloud runner is now active and monitoring servers")
}

// Start
main().catch(console.error)

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[v0] Shutting down gracefully...")
  for (const [serverId, proc] of runningProcesses) {
    console.log(`[v0] Stopping server: ${serverId}`)
    proc.kill("SIGTERM")
  }
  process.exit(0)
})
