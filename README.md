# Minecraft Tower Builder Bot

An automated Minecraft bot built using [Mineflayer](https://github.com/PrismarineJS/mineflayer) and [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) to build automated cactus/sand towers on multiplayer servers.

## Installation

1. Ensure [Node.js](https://nodejs.org/) (v14+) is installed.
2. Install dependencies:
   ```bash
   npm install
   ```

## Configuration

Update `config.json` with your server info, bot login credentials, and coordinates:

```json
{
  "host": "craftmc.pl",
  "port": 25565,
  "username": "czokaar",
  "password": "gFB(m7c+$mRzQ><gwZ;X",
  "auth": "offline",
  "needsHub": true,
  "version": "1.12.2",
  "floorsToBuild": 5,
  "storageCoordinates": {
    "x": -4572,
    "y": 85,
    "z": -1525
  }
}
```

* **`host` / `port` / `version`**: Target server details.
* **`username` / `password`**: Login credentials (sends `/login <password>` automatically).
* **`needsHub`**: Set to `true` to auto-lobby navigate to Skyblock.
* **`floorsToBuild`**: Floors per tower.
* **`storageCoordinates`**: Coordinates of the restock double chest.

## Running the Bot

Run the main bot process:
```bash
node index.js
```

## Chat Interaction (In-Game)

Only whitelisted players (e.g. `BigSplash_Best`) can control the bot. Send commands via private messages (whisper):

* `/msg czokaar start` — Teleports the bot to the island (`/is go`) and starts the automated build loop.
* `/msg czokaar stop` — Halts building and pathfinding.
* `/msg czokaar status` — Whispers current floor progress and inventory material status.
