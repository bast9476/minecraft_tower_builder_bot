const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const vec3 = require('vec3');

const config = require('./config.json');
const stateManager = require('./stateManager');
const Navigation = require('./navigation');
const InventoryManager = require('./inventoryManager');
const Builder = require('./builder');

let bot;
let navigation;
let inventoryManager;
let builder;
let defaultMove;

let hasLoggedIn = false;
let isBuilding = false;

function initBot() {
  console.log('Connecting to Minecraft server...');
  bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth,
    version: config.version
  });

  bot.loadPlugin(pathfinder);

  const originalClickWindow = bot.clickWindow;
  bot.clickWindow = async function (slot, mouseButton, mode) {
    if (bot.waitForTicks) {
      await bot.waitForTicks(4);
    } else {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return originalClickWindow.call(bot, slot, mouseButton, mode);
  };

  navigation = new Navigation(bot);
  inventoryManager = new InventoryManager(bot, config, navigation);
  builder = new Builder(bot, config, navigation);

  bot.on('spawn', async () => {

    const passableBlocks = ['chest', 'trapped_chest', 'ender_chest', 'hopper'];
    for (const name of passableBlocks) {
      const b = bot.registry.blocksByName[name];
      if (b) {
        b.boundingBox = 'empty';
        b.shapes = [];
        if (b.stateShapes) b.stateShapes = [];
        if (b.variations) {
          for (const v of b.variations) {
            v.shapes = [];
          }
        }
      }
    }
    for (const b of bot.registry.blocksArray) {
      if (b.name && b.name.includes('shulker_box')) {
        b.boundingBox = 'empty';
        b.shapes = [];
        if (b.stateShapes) b.stateShapes = [];
        if (b.variations) {
          for (const v of b.variations) {
            v.shapes = [];
          }
        }
      }
    }

    const mcData = require('minecraft-data')(bot.version);
    defaultMove = new Movements(bot, mcData);

    const cactusBlock = bot.registry.blocksByName.cactus;
    if (cactusBlock) {
      defaultMove.blocksToAvoid.add(cactusBlock.id);
    }

    defaultMove.allowBridging = false;
    defaultMove.canDig = false;
    defaultMove.allowParkour = true;
    defaultMove.openDoors = true;
    defaultMove.allowSprinting = false;
    bot.pathfinder.setMovements(defaultMove);
    console.log('Bot spawned!');

    if (!hasLoggedIn) {
      hasLoggedIn = true;

      if (config.password) {
        console.log(`Sending login command: /login ${config.password}`);
        try {
          bot.chat(`/login ${config.password}`);
          await bot.waitForTicks(40);
        } catch (err) {
          console.error('Login action failed:', err.message);
        }
      }

      if (config.needsHub) {
        console.log('Hub spawned. Executing lobby select sequence...');
        try {
          bot.setQuickBarSlot(0);
          bot.activateItem();

          bot.once('windowOpen', async (window) => {
            console.log('GUI opened, clicking slot 15...');
            try {
              await bot.clickWindow(15, 0, 0);
              console.log('Clicked slot 15. Waiting to join skyblock server...');
            } catch (err) {
              console.error('Failed to click window slot 15:', err);
            }
          });
        } catch (err) {
          console.error('Login sequence error:', err);
        }
      } else {
        console.log('Skyblock server spawned. Ready. (Ready to start)');
      }
    }
  });

  bot.on('messagestr', handleChat);

  bot.on('end', () => {
    console.log('Bot disconnected. Reconnecting in 10 seconds...');
    hasLoggedIn = false;
    setTimeout(() => {
      initBot();
    }, 10000);
  });

  bot.on('kicked', (reason, loggedIn) => {
    console.log(`Bot kicked. Reason: ${reason} | loggedIn: ${loggedIn}`);
  });

  bot.on('error', (err) => {
    console.error('Bot Error:', err);
  });
}

function whisper(username, message) {
  if (username) {
    try {
      bot.chat(`/msg ${username} ${message}`);
    } catch (err) {
      console.error(`Failed to whisper to ${username}:`, err.message);
    }
  }
  console.log(`[WHISPER to ${username || 'unknown'}]: ${message}`);
}

async function handleChat(message, messagePosition, jsonMsg) {
  console.log("RECEIVED CHAT:", message);
  if (message.includes(`<${bot.username}>`)) return;

  let match = message.match(/\[([A-Za-z0-9_\-]+)\s*->\s*(?:me|you|BossCraft|BossCraftTest)\]/i);
  if (!match) match = message.match(/^From\s+([A-Za-z0-9_\-]+):/i);
  if (!match) match = message.match(/^([A-Za-z0-9_\-]+)\s+whispers:/i);
  if (!match) match = message.match(/([A-Za-z0-9_\-]+)\s*»/);
  if (!match) match = message.match(/<([A-Za-z0-9_\-]+)>/);

  if (!match) return;

  const sender = match[1];
  if (sender !== 'apt' && sender !== 'Arsenic-23' && sender !== 'BossCraftTest' && sender !== 'mateuszzzt') {
    return;
  }

  let username = sender;

  if (message.includes('setup')) {
    if (isBuilding) {
      isBuilding = false;
      try {
        bot.pathfinder.setGoal(null);
        await bot.waitForTicks(10);
      } catch (err) {
        console.error('Reset pathfinder failed:', err.message);
      }
    }

    stateManager.state.completedTowers = [];
    stateManager.state.currentTower = null;
    stateManager.state.currentFloor = 0;
    stateManager.state.currentStep = 0;
    stateManager.saveState();

    try {
      whisper(username, "Setting up test environment...");

      bot.chat(`/tp @s ${username}`);
      await bot.waitForTicks(60);

      bot.chat('/fill ~-3 ~ ~-4 ~9 ~45 ~4 air');
      await bot.waitForTicks(5);

      bot.chat('/setblock ~ ~ ~-3 chest');
      await bot.waitForTicks(5);

      bot.chat('/item replace block ~ ~ ~-3 container.0 with sand 64');
      bot.chat('/item replace block ~ ~ ~-3 container.1 with sand 64');
      bot.chat('/item replace block ~ ~ ~-3 container.2 with sand 64');
      bot.chat('/item replace block ~ ~ ~-3 container.3 with cactus 64');
      bot.chat('/item replace block ~ ~ ~-3 container.4 with cactus 64');
      bot.chat('/item replace block ~ ~ ~-3 container.5 with cactus 64');
      bot.chat('/item replace block ~ ~ ~-3 container.6 with iron_bars 64');
      bot.chat('/item replace block ~ ~ ~-3 container.7 with dirt 64');
      bot.chat('/item replace block ~ ~ ~-3 container.8 with ladder 64');
      bot.chat('/item replace block ~ ~ ~-3 container.9 with diamond_shovel 1');
      bot.chat('/item replace block ~ ~ ~-3 container.10 with diamond_pickaxe 1');
      bot.chat('/item replace block ~ ~ ~-3 container.11 with oak_leaves 64');
      bot.chat('/item replace block ~ ~ ~-3 container.12 with oak_leaves 64');
      bot.chat('/item replace block ~ ~ ~-3 container.13 with iron_bars 64');
      await bot.waitForTicks(5);

      bot.chat('/fill ~-2 ~-1 ~-3 ~8 ~-1 ~3 dirt');

      bot.chat('/setblock ~4 ~-1 ~ sandstone');
      await bot.waitForTicks(10);

      const pos = bot.entity.position.floored();
      config.storageCoordinates = { x: pos.x, y: pos.y, z: pos.z - 3 };

      const fs = require('fs');
      fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));

      whisper(username, `Set chest coordinates to X:${pos.x} Y:${pos.y} Z:${pos.z - 3}! You can type 'start' now.`);
    } catch (err) {
      console.error('Setup steps failed:', err.message);
    }
  } else if (message.includes('start')) {
    if (!config.storageCoordinates) {
      try {
        whisper(username, 'Please type "setup" first so I know where to build!');
      } catch (err) {
        console.error('Failed to whisper:', err.message);
      }
      return;
    }

    try {

      bot.chat('/is go');
      await bot.waitForTicks(40);

      if (isBuilding) {
        whisper(username, 'Already building!');
        return;
      }
      whisper(username, 'Starting build process...');
      isBuilding = true;
      startBuildLoop(username);
    } catch (err) {
      console.error('Start sequence failed:', err.message);
    }
  } else if (message.includes('stop')) {
    try {
      whisper(username, 'Stopping...');
      isBuilding = false;
      bot.pathfinder.setGoal(null);
    } catch (err) {
      console.error('Stop command failed:', err.message);
    }
  } else if (message.includes('status')) {
    try {
      const progress = stateManager.getProgress();
      const mats = inventoryManager.getMaterialsRemaining();
      whisper(username, `Status: Completed Towers: ${progress.completedTowers}, Current Floor: ${progress.currentFloor}/${config.floorsToBuild}`);
      whisper(username, `Materials: ${mats.sand} Sand, ${mats.cactus} Cactus, ${mats.ironBars} Iron Bars`);
    } catch (err) {
      console.error('Status query failed:', err.message);
    }
  } else if (message.includes('pathstate')) {
    try {
      const goal = bot.pathfinder.goal;
      whisper(username, `Pos: ${bot.entity.position} | Goal: ${goal ? JSON.stringify(goal) : 'null'} | Moving: ${bot.pathfinder.isMoving()}`);
    } catch (err) {
      console.error('Pathstate query failed:', err.message);
    }
  }
}

async function startBuildLoop(ownerUsername = null) {
  const unreachableBases = [];
  while (isBuilding) {
    try {
      await inventoryManager.checkAndRestock();

      const bases = navigation.findSandstoneBase(config);
      let targetBase = null;

      for (const base of bases) {
        const isUnreachable = unreachableBases.some(b => b.x === base.x && b.y === base.y && b.z === base.z);
        if (!stateManager.isTowerCompleted(base) && !isUnreachable) {
          targetBase = base;
          break;
        }
      }

      if (!targetBase) {
        console.log('No available sandstone bases found. Pausing...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      console.log(`Found base at ${targetBase.x}, ${targetBase.y}, ${targetBase.z}`);

      const startFloor = stateManager.state.currentFloor;
      try {
        const clearStartY = targetBase.y + (startFloor * 4) + 1;
        console.log(`Clearing build volume for tower at ${targetBase.x}, ${targetBase.y}, ${targetBase.z} starting from Y=${clearStartY}`);
        bot.chat(`/fill ${targetBase.x - 3} ${clearStartY} ${targetBase.z - 3} ${targetBase.x + 3} ${targetBase.y + 40} ${targetBase.z + 3} air`);
        await bot.waitForTicks(15);
      } catch (clearErr) {
        console.error('Failed to clear tower build volume:', clearErr.message);
      }

      const adjacentPos = vec3(targetBase.x + 1.5, targetBase.y + 1, targetBase.z + 0.5);
      console.log(`Navigating to adjacent base spot at ${targetBase.x + 1.5}, ${targetBase.y + 1}, ${targetBase.z + 0.5}`);

      try {
        const { GoalNear } = require('mineflayer-pathfinder').goals;
        const testGoal = new GoalNear(adjacentPos.x, adjacentPos.y, adjacentPos.z, 0.35);
        const pathResult = bot.pathfinder.getPathTo(defaultMove, testGoal, 3000);
        console.log(`[PATHFINDER DIAGNOSTIC] A* Status: ${pathResult.status}, Nodes Explored: ${pathResult.visitedNodes}, Path Length: ${pathResult.path ? pathResult.path.length : 0}`);
      } catch (pathErr) {
        console.error('[PATHFINDER DIAGNOSTIC] Error calculating A* path:', pathErr.message);
      }

      const reachedBase = await navigation.gotoExact(adjacentPos, 20000);
      await bot.waitForTicks(10);

      if (!reachedBase) {
        console.warn(`[BUILD_LOOP] Could not navigate to base at ${targetBase.x}, ${targetBase.y}, ${targetBase.z}. Skipping and marking as unreachable.`);

        const start = bot.entity.position.floored();
        const end = vec3(targetBase.x, targetBase.y + 1, targetBase.z);
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const dz = end.z - start.z;
        const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
        let airCount = 0;
        let blockCount = 0;

        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const p = vec3(
            Math.floor(start.x + dx * t),
            Math.floor(start.y + dy * t),
            Math.floor(start.z + dz * t)
          );
          const blockUnder = bot.blockAt(p.offset(0, -1, 0));
          const blockAtFeet = bot.blockAt(p);
          const blockAtHead = bot.blockAt(p.offset(0, 1, 0));

          if (!blockUnder || blockUnder.name === 'air') {
            airCount++;
          } else {
            blockCount++;
          }

          if (blockAtFeet && blockAtFeet.name !== 'air') {
            console.log(`[PATH_DEBUG] Feet level block at ${p}: ${blockAtFeet.name}`);
          }
          if (blockAtHead && blockAtHead.name !== 'air') {
            console.log(`[PATH_DEBUG] Head level block at ${p.offset(0, 1, 0)}: ${blockAtHead.name}`);
          }
        }
        console.log(`[PATH_DEBUG] Path from ${start} to ${end}: ${blockCount} solid blocks, ${airCount} air/void blocks.`);

        const msg = `Cannot reach base at X:${targetBase.x} Y:${targetBase.y} Z:${targetBase.z}! (Path has ${airCount} blocks of empty air/void). Please build a bridge!`;
        whisper(ownerUsername, msg);

        unreachableBases.push(targetBase);
        continue;
      }

      stateManager.setCurrentTower(targetBase);

      for (let floor = startFloor; floor < config.floorsToBuild; floor++) {
        if (!isBuilding) break;

        console.log(`Building floor ${floor + 1} of ${config.floorsToBuild}`);
        // Stand near tower center to start building floor (if not already inside tower column)
        const targetY = (bot.entity.position.y < targetBase.y + 1 + floor * 4 - 0.5)
          ? (targetBase.y + 1)
          : (targetBase.y + 1 + floor * 4);
        const currentCenterPos = vec3(targetBase.x + 0.5, targetY, targetBase.z + 0.5);
        const dx = Math.abs(bot.entity.position.x - currentCenterPos.x);
        const dz = Math.abs(bot.entity.position.z - currentCenterPos.z);
        if (dx > 2 || dz > 2) {
          await navigation.gotoExact(currentCenterPos);
        }

        // Debug scan blocks
        console.log("DEBUG SCAN FOR TOWER AT Y=5 to Y=12:");
        for (let y = 5; y <= 12; y++) {
          let yOutput = [];
          for (let dx = -3; dx <= 3; dx++) {
            for (let dz = -3; dz <= 3; dz++) {
              const checkPos = vec3(targetBase.x + dx, y, targetBase.z + dz);
              const block = bot.blockAt(checkPos);
              if (block && block.name !== 'air') {
                yOutput.push(`(${dx}, ${dz}): ${block.name}`);
              }
            }
          }
          if (yOutput.length > 0) {
            console.log(`  Y = ${y}: ${yOutput.join(', ')}`);
          }
        }

        await builder.buildFloor(targetBase, floor);
        stateManager.updateProgress(floor + 1, 0);
      }

      if (isBuilding && stateManager.state.currentFloor >= config.floorsToBuild) {
        stateManager.markTowerCompleted(targetBase);
        whisper(ownerUsername, `Tower at ${targetBase.x}, ${targetBase.y}, ${targetBase.z} completed!`);
        console.log('Restocking for the next tower...');
        // Teleport back to spawn to safely access chest level
        bot.chat('/is go');
        await bot.waitForTicks(40);
        await inventoryManager.restock();
      }

    } catch (err) {
      if (err.message === 'previous_floor_missing') {
        console.log('Detected missing previous floor blocks. Rolling back floor progress by 1...');
        stateManager.state.currentFloor = Math.max(0, stateManager.state.currentFloor - 1);
        stateManager.saveState();
      } else {
        console.error('Error in build loop:', err);
      }
      console.log('An error occurred. Retrying in 5 seconds...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

process.stdin.on('data', (data) => {
  const line = data.toString().trim();
  console.log(`[CONSOLE INPUT]: ${line}`);
  if (line === 'start') {
    if (!config.storageCoordinates) {
      console.log('Please configure storageCoordinates first!');
      return;
    }
    if (isBuilding) {
      console.log('Already building!');
      return;
    }
    isBuilding = true;
    (async () => {
      try {
        bot.chat('/is go');
        await bot.waitForTicks(40);
      } catch (err) {
        console.error('Teleport on start failed:', err.message);
      }
      startBuildLoop();
    })();
  } else if (line === 'stop') {
    isBuilding = false;
    bot.pathfinder.setGoal(null);
    console.log('Stopping...');
  } else if (line === 'status') {
    const progress = stateManager.getProgress();
    const mats = inventoryManager.getMaterialsRemaining();
    console.log(`Status: Completed Towers: ${progress.completedTowers.length}, Current Floor: ${progress.currentFloor}/${config.floorsToBuild}`);
    console.log(`Materials: ${mats.sand} Sand, ${mats.cactus} Cactus, ${mats.ironBars} Iron Bars`);
  } else if (line === 'inv') {
    console.log('Bot Inventory:');
    if (bot && bot.inventory) {
      for (const item of bot.inventory.items()) {
        console.log(`  ${item.name} x ${item.count} (slot: ${item.slot})`);
      }
    } else {
      console.log('Bot not initialized yet');
    }
  } else if (line === 'pos') {
    if (bot && bot.entity) {
      console.log(`Bot Position: ${bot.entity.position}`);
    } else {
      console.log('Bot not spawned yet');
    }
  } else if (line === 'block') {
    if (bot && bot.entity) {
      console.log(`Bot Position: ${bot.entity.position} | Yaw: ${bot.entity.yaw} | Pitch: ${bot.entity.pitch} | onGround: ${bot.entity.onGround}`);

      const start = bot.entity.position.floored().offset(-4, -1, -4);
      console.log(`Scanning 9x3x9 blocks around ${bot.entity.position}:`);
      for (let dx = 0; dx < 9; dx++) {
        for (let dy = 0; dy < 3; dy++) {
          for (let dz = 0; dz < 9; dz++) {
            const p = start.offset(dx, dy, dz);
            const b = bot.blockAt(p);
            if (b && b.name !== 'air') {
              console.log(`  At ${p} (${dx-4}, ${dy-1}, ${dz-4}): ${b.name} (boundingBox: ${b.boundingBox}, shapes: ${JSON.stringify(b.shapes)})`);
            }
          }
        }
      }

      console.log('Nearby entities (within 6 blocks):');
      for (const id of Object.keys(bot.entities)) {
        const ent = bot.entities[id];
        if (ent && ent !== bot.entity) {
          const dist = bot.entity.position.distanceTo(ent.position);
          if (dist <= 6) {
            console.log(`  Entity ${ent.name || ent.type} (id: ${id}) at ${ent.position} (dist: ${dist.toFixed(2)})`);
          }
        }
      }

      const controls = {
        forward: bot.controlState.forward,
        back: bot.controlState.back,
        left: bot.controlState.left,
        right: bot.controlState.right,
        jump: bot.controlState.jump,
        sprint: bot.controlState.sprint,
        sneak: bot.controlState.sneak
      };
      console.log(`Bot Controls: ${JSON.stringify(controls)}`);
      console.log(`Bot Velocity: ${bot.entity.velocity}`);
      console.log(`Pathfinder Moving: ${bot.pathfinder.isMoving()} | Goal: ${bot.pathfinder.goal ? JSON.stringify(bot.pathfinder.goal) : 'null'}`);
    } else {
      console.log('Bot not spawned yet');
    }
  } else if (line.startsWith('chat ')) {
    const msg = line.substring(5);
    console.log(`Sending chat from console: ${msg}`);
    bot.chat(msg);
  } else if (line.startsWith('setup ')) {
    const username = line.substring(6);
    console.log(`Executing setup for player ${username}...`);
    (async () => {
      try {
        bot.chat(`/tp @s ${username}`);
        await bot.waitForTicks(60);
        bot.chat('/fill ~-3 ~ ~-4 ~9 ~45 ~4 air');
        await bot.waitForTicks(5);
        bot.chat('/setblock ~ ~ ~-3 chest');
        await bot.waitForTicks(5);
        bot.chat('/item replace block ~ ~ ~-3 container.0 with sand 64');
        bot.chat('/item replace block ~ ~ ~-3 container.1 with sand 64');
        bot.chat('/item replace block ~ ~ ~-3 container.2 with sand 64');
        bot.chat('/item replace block ~ ~ ~-3 container.3 with cactus 64');
        bot.chat('/item replace block ~ ~ ~-3 container.4 with cactus 64');
        bot.chat('/item replace block ~ ~ ~-3 container.5 with cactus 64');
        bot.chat('/item replace block ~ ~ ~-3 container.6 with iron_bars 64');
        bot.chat('/item replace block ~ ~ ~-3 container.7 with dirt 64');
        bot.chat('/item replace block ~ ~ ~-3 container.8 with ladder 64');
        bot.chat('/item replace block ~ ~ ~-3 container.9 with diamond_shovel 1');
        bot.chat('/item replace block ~ ~ ~-3 container.10 with diamond_pickaxe 1');
        bot.chat('/item replace block ~ ~ ~-3 container.11 with oak_leaves 64');
        bot.chat('/item replace block ~ ~ ~-3 container.12 with oak_leaves 64');
        bot.chat('/item replace block ~ ~ ~-3 container.13 with iron_bars 64');
        await bot.waitForTicks(5);
        bot.chat('/fill ~-2 ~-1 ~-3 ~8 ~-1 ~3 dirt');
        bot.chat('/setblock ~4 ~-1 ~ sandstone');
        await bot.waitForTicks(10);

        const pos = bot.entity.position.floored();
        config.storageCoordinates = { x: pos.x, y: pos.y, z: pos.z - 3 };
        const fs = require('fs');
        fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
        console.log(`Setup complete! Storage coordinates set to X:${pos.x} Y:${pos.y} Z:${pos.z - 3}`);
      } catch (err) {
        console.error('Setup failed:', err.message);
      }
    })();
  }
});

initBot();
