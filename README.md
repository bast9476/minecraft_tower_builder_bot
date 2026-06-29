# Minecraft Tower Builder Bot

An automated Minecraft bot built using [Mineflayer](https://github.com/PrismarineJS/mineflayer) and [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) to construct automated cactus/sand towers. It connects to a server, automatically pathfinds, manages inventory materials, and builds multi-floor structures.

## Installation

1. Make sure [Node.js](https://nodejs.org/) (v14 or higher recommended) is installed.
2. Clone or extract this repository to your local directory.
3. Open a terminal in the project directory and run:
   ```bash
   npm install
   ```

## Configuration

Modify the `config.json` file to customize bot behavior and connection details:

```json
{
  "host": "craftmc.pl",
  "port": 25565,
  "username": "BossCraft",
  "password": "elo321",
  "auth": "offline",
  "needsHub": true,
  "version": "1.12.2",
  "floorsToBuild": 5,
  "storageCoordinates": {
    "x": -8464,
    "y": 6,
    "z": 4049
  },
  "blocks": {
    "base": "sandstone",
    "sand": "sand",
    "cactus": "cactus",
    "ironBars": "iron_bars",
    "scaffold": "dirt",
    "ladder": "ladder",
    "oakLeaves": "leaves"
  },
  "farmSize": 5
}
```

### Config Key Details

*   **`host`**: The IP address or hostname of the Minecraft server.
*   **`port`**: The server port (default: `25565`).
*   **`username`**: The Minecraft username for the bot.
*   **`password`**: The password used to run `/login <password>` upon connecting.
*   **`auth`**: Authentication method (e.g., `"offline"` or `"microsoft"`).
*   **`needsHub`**: Set to `true` if the bot spawns in a lobby and needs to click an item in its hotbar (slot 0) and GUI (slot 15) to transfer to the skyblock server.
*   **`version`**: The Minecraft server version (e.g., `"1.12.2"`).
*   **`floorsToBuild`**: Number of floors to construct for each tower.
*   **`storageCoordinates`**: The coordinates (`x`, `y`, `z`) of the chest where the bot restocks materials.
*   **`blocks`**: Block name mappings for matching in-game blocks.
*   **`farmSize`**: Dimension size of the farm grid.

---

## How to Run

To run the bot, start the main script:
```bash
node index.js
```

---

## Bot Interaction & Commands

You can control the bot via Minecraft chat commands or through standard input in the console.

### 1. Chat Commands (Minecraft)
Only players listed in the owner whitelist (e.g., `apt`, `Arsenic-23`, `BossCraftTest`, `mateuszzzt` inside `index.js`) can issue whispers/chat commands:

*   **`setup`**:
    *   Teleports the bot to your current location.
    *   Clears a volume for construction.
    *   Places a chest containing necessary tools and materials.
    *   Creates a dirt platform and sandstone marker.
    *   Automatically updates `config.json` with the chest coordinates and saves it.
*   **`start`**: Teleports the bot to the island (`/is go`) and initiates the automatic build and restock loop.
*   **`stop`**: Halts all pathfinding and halts construction.
*   **`status`**: Whispers the bot's current build status and inventory levels.
*   **`pathstate`**: Reports position, current pathfinding goal, and movement status.

### 2. Console Commands (Standard Input)
Type directly into the terminal running the bot:

*   **`start`**: Teleports the bot (`/is go`) and starts building.
*   **`stop`**: Stops movement and building.
*   **`status`**: Outputs completion statistics and inventory levels.
*   **`inv`**: Lists all items and slot counts currently in the bot's inventory.
*   **`pos`**: Logs the exact current coordinates of the bot.
*   **`block`**: Diagnoses nearby block states (9x3x9 area) and entities within 6 blocks.
*   **`chat <message>`**: Broadcasts a chat message from the bot.
*   **`setup <username>`**: Runs the setup sequence targetting the specified player.
