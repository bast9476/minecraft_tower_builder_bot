const vec3 = require('vec3');

class InventoryManager {
  constructor(bot, config, navigation) {
    this.bot = bot;
    this.config = config;
    this.navigation = navigation;
  }

  getRequiredMaterials() {
    const stateManager = require('./stateManager');
    const currentFloor = stateManager.state.currentFloor || 0;

    const remainingFloorsInCurrent = Math.max(1, this.config.floorsToBuild - currentFloor);
    const floorsToStock = remainingFloorsInCurrent + (this.config.floorsToBuild * 2);
    return {
      sand: floorsToStock * 16 + 20,
      cactus: floorsToStock * 24 + 20,
      ironBars: floorsToStock * 12 + 20,
      oakLeaves: floorsToStock * 12 + 20,
      scaffold: 16,
      ladder: 16
    };
  }

  async checkAndRestock() {
    const sandCount = this.bot.inventory.items().filter(item => item.name === this.config.blocks.sand).reduce((acc, item) => acc + item.count, 0);
    const cactusCount = this.bot.inventory.items().filter(item => item.name === this.config.blocks.cactus).reduce((acc, item) => acc + item.count, 0);
    const ironBarsCount = this.bot.inventory.items().filter(item => item.name === this.config.blocks.ironBars).reduce((acc, item) => acc + item.count, 0);
    const scaffoldCount = this.bot.inventory.items().filter(item => item.name === this.config.blocks.scaffold).reduce((acc, item) => acc + item.count, 0);
    const ladderCount = this.bot.inventory.items().filter(item => item.name === this.config.blocks.ladder).reduce((acc, item) => acc + item.count, 0);
    const oakLeavesCount = this.bot.inventory.items().filter(item => item.name === this.config.blocks.oakLeaves).reduce((acc, item) => acc + item.count, 0);

    console.log(`Inventory: ${sandCount} Sand, ${cactusCount} Cactus, ${ironBarsCount} Iron Bars, ${scaffoldCount} Scaffold, ${ladderCount} Ladders, ${oakLeavesCount} Oak Leaves`);

    const stateManager = require('./stateManager');
    const currentFloor = stateManager.state.currentFloor || 0;
    const remainingFloors = Math.max(1, this.config.floorsToBuild - currentFloor);

    const minSand = remainingFloors * 20 + 16;
    const minCactus = remainingFloors * 16;
    const minIronBars = remainingFloors * 12;
    const minOakLeaves = remainingFloors * 16;
    const hasShovel = this.bot.inventory.items().some(item => item.name.includes('shovel'));

    if (sandCount < minSand || cactusCount < minCactus || ironBarsCount < minIronBars || oakLeavesCount < minOakLeaves || !hasShovel) {
      console.log(`Low on materials (min needed: ${minSand} Sand, ${minCactus} Cactus, ${minIronBars} Iron, ${minOakLeaves} Leaves) or missing shovel, restocking...`);
      const success = await this.restock();
      if (!success) {
        throw new Error('Restocking failed! Chest is empty, missing, or unreachable.');
      }
    }
  }

  async restock() {
    const originalPos = this.bot.entity.position.clone();
    const vec3 = require('vec3');
    const chestPos = vec3(this.config.storageCoordinates);

    console.log('Attempting to teleport to storage via /is go...');
    this.bot.chat('/is go');
    await this.bot.waitForTicks(40);

    const reached = await this.navigation.goto(chestPos);
    if (!reached) {
      console.error('Failed to navigate to storage chest!');
      return false;
    }

    const matchingIds = [];
    for (const block of Object.values(this.bot.registry.blocks)) {
      if (block.name.includes('chest') || block.name.includes('shulker')) {
        matchingIds.push(block.id);
      }
    }

    const chestPoints = this.bot.findBlocks({
      matching: matchingIds,
      maxDistance: 8,
      count: 20
    });

    const reachableChestPoints = chestPoints.filter(p => Math.abs(p.y - chestPos.y) <= 1.5);

    if (reachableChestPoints.length === 0) {
      console.error(`No reachable chests or storage containers found near storage coordinates ${chestPos}!`);
      return false;
    }

    reachableChestPoints.sort((a, b) => a.distanceTo(chestPos) - b.distanceTo(chestPos));
    console.log(`Found ${reachableChestPoints.length} reachable chest(s) near storage coordinates.`);

    let withdrewAny = false;
    const openedChests = [];

    for (let i = 0; i < reachableChestPoints.length; i++) {
      const targetPos = reachableChestPoints[i];
      const targetBlock = this.bot.blockAt(targetPos);
      if (!targetBlock) continue;

      const isDoubleChestPart = openedChests.some(pos => pos.distanceTo(targetPos) <= 1.01);
      if (isDoubleChestPart) {
        console.log(`Skipping chest at ${targetPos} as it is adjacent to an already opened chest.`);
        continue;
      }

      const sandCount = this.bot.inventory.items().filter(item => item.name === this.config.blocks.sand).reduce((acc, item) => acc + item.count, 0);
      const cactusCount = this.bot.inventory.items().filter(item => item.name === this.config.blocks.cactus).reduce((acc, item) => acc + item.count, 0);
      const ironBarsCount = this.bot.inventory.items().filter(item => item.name === this.config.blocks.ironBars).reduce((acc, item) => acc + item.count, 0);
      const oakLeavesCount = this.bot.inventory.items().filter(item => item.name === this.config.blocks.oakLeaves).reduce((acc, item) => acc + item.count, 0);
      const hasShovel = this.bot.inventory.items().some(item => item.name.includes('shovel'));

      const req = this.getRequiredMaterials();
      const fullyStocked = (sandCount >= req.sand && cactusCount >= req.cactus && ironBarsCount >= req.ironBars && oakLeavesCount >= req.oakLeaves && hasShovel);

      if (fullyStocked) {
        console.log('Fully stocked now. Skipping remaining chests.');
        break;
      }

      console.log(`Navigating to chest #${i + 1} at ${targetPos}...`);
      const { goals } = require('mineflayer-pathfinder');
      const chestGoal = new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 3);
      const reachedChest = await this.navigation.gotoWithTimeout(chestGoal, 10000);
      if (!reachedChest) {
        console.warn(`Failed to navigate within reach of chest at ${targetPos}, trying next chest.`);
        continue;
      }

      await this.bot.waitForTicks(5);
      try {
        await this.bot.lookAt(targetPos.offset(0.5, 0.5, 0.5), true);
      } catch (lookErr) {}
      await this.bot.waitForTicks(2);

      try {

        console.log(`Opening chest at ${targetPos}...`);
        const chest = await Promise.race([
          this.bot.openContainer(targetBlock),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Chest open timed out')), 2000))
        ]);
        console.log(`Opened chest at ${targetPos}`);
        openedChests.push(targetPos);

        const essentialItemNames = [
          this.config.blocks.sand,
          this.config.blocks.cactus,
          this.config.blocks.ironBars,
          this.config.blocks.scaffold,
          this.config.blocks.ladder,
          this.config.blocks.oakLeaves,
          'diamond_shovel',
          'diamond_pickaxe',
          'shovel',
          'pickaxe'
        ];
        for (const item of this.bot.inventory.items()) {
          const isEssential = essentialItemNames.some(name => item.name.includes(name) || name.includes(item.name));
          if (!isEssential) {
            try {
              await chest.deposit(item.type, null, item.count);
              console.log(`Deposited non-essential item ${item.name} (${item.count})`);
            } catch (err) {
              console.error(`Failed to deposit non-essential ${item.name}:`, err.message);
            }
            await this.bot.waitForTicks(10);
          }
        }

        const itemsToDeposit = [
          { name: this.config.blocks.sand, max: req.sand },
          { name: this.config.blocks.cactus, max: req.cactus },
          { name: this.config.blocks.ironBars, max: req.ironBars },
          { name: this.config.blocks.scaffold, max: req.scaffold },
          { name: this.config.blocks.ladder, max: req.ladder },
          { name: this.config.blocks.oakLeaves, max: req.oakLeaves }
        ];

        for (const itemRequest of itemsToDeposit) {
          const itemType = this.bot.registry.itemsByName[itemRequest.name]?.id;
          if (itemType) {
            const invCount = this.bot.inventory.items().filter(item => item.type === itemType).reduce((acc, item) => acc + item.count, 0);
            if (invCount > itemRequest.max) {
              const excess = invCount - itemRequest.max;
              try {
                await chest.deposit(itemType, null, excess);
                console.log(`Deposited excess ${excess} of ${itemRequest.name}`);
              } catch (err) {
                console.error(`Failed to deposit excess ${itemRequest.name}:`, err.message);
              }
              await this.bot.waitForTicks(10);
            }
          }
        }

        const itemsToGet = [
          { name: this.config.blocks.sand, count: req.sand },
          { name: this.config.blocks.cactus, count: req.cactus },
          { name: this.config.blocks.ironBars, count: req.ironBars },
          { name: this.config.blocks.scaffold, count: req.scaffold },
          { name: this.config.blocks.ladder, count: req.ladder },
          { name: this.config.blocks.oakLeaves, count: req.oakLeaves }
        ];

        for (const itemRequest of itemsToGet) {
          const itemType = this.bot.registry.itemsByName[itemRequest.name]?.id;
          if (!itemType) continue;
          const chestItemCount = chest.containerItems().filter(item => item.type === itemType).reduce((acc, item) => acc + item.count, 0);

          const invCount = this.bot.inventory.items().filter(item => item.type === itemType).reduce((acc, item) => acc + item.count, 0);
          const needed = itemRequest.count - invCount;

          if (needed > 0 && chestItemCount > 0) {
            const amountToTake = Math.min(needed, chestItemCount);
            try {
              await chest.withdraw(itemType, null, amountToTake);
              console.log(`Withdrew ${amountToTake} of ${itemRequest.name}`);
              withdrewAny = true;
            } catch (err) {
              console.error(`Failed to withdraw ${itemRequest.name}:`, err.message);
            }
            await this.bot.waitForTicks(10);
          }
        }

        const toolsToWithdraw = [];
        if (!this.bot.inventory.items().some(item => item.name.includes('shovel'))) {
          toolsToWithdraw.push('diamond_shovel');
        }
        if (!this.bot.inventory.items().some(item => item.name.includes('pickaxe'))) {
          toolsToWithdraw.push('diamond_pickaxe');
        }

        for (const toolName of toolsToWithdraw) {
          const itemType = this.bot.registry.itemsByName[toolName]?.id;
          if (itemType) {
            const chestItem = chest.containerItems().find(item => item.type === itemType);
            if (chestItem) {
              try {
                await chest.withdraw(itemType, null, 1);
                console.log(`Withdrew ${toolName}`);
                withdrewAny = true;
              } catch (err) {
                console.error(`Failed to withdraw ${toolName}:`, err.message);
              }
              await this.bot.waitForTicks(10);
            }
          }
        }

        await chest.close();
        await this.bot.waitForTicks(10);
      } catch (err) {
        console.error(`Failed to interact with chest at ${targetPos}:`, err.message);
      }
    }

    const finalSandCount = this.bot.inventory.items().filter(item => item.name === this.config.blocks.sand).reduce((acc, item) => acc + item.count, 0);
    const finalCactusCount = this.bot.inventory.items().filter(item => item.name === this.config.blocks.cactus).reduce((acc, item) => acc + item.count, 0);
    const finalIronBarsCount = this.bot.inventory.items().filter(item => item.name === this.config.blocks.ironBars).reduce((acc, item) => acc + item.count, 0);
    const finalOakLeavesCount = this.bot.inventory.items().filter(item => item.name === this.config.blocks.oakLeaves).reduce((acc, item) => acc + item.count, 0);
    const finalHasShovel = this.bot.inventory.items().some(item => item.name.includes('shovel'));

    const req = this.getRequiredMaterials();
    const fullyStocked = (finalSandCount >= req.sand && finalCactusCount >= req.cactus && finalIronBarsCount >= req.ironBars && finalOakLeavesCount >= req.oakLeaves && finalHasShovel);

    return withdrewAny || fullyStocked;
  }

  getMaterialsRemaining() {
    const items = this.bot.inventory.items();
    return {
      sand: items.filter(i => i.name === this.config.blocks.sand).reduce((a, b) => a + b.count, 0),
      cactus: items.filter(i => i.name === this.config.blocks.cactus).reduce((a, b) => a + b.count, 0),
      ironBars: items.filter(i => i.name === this.config.blocks.ironBars).reduce((a, b) => a + b.count, 0),
      scaffold: items.filter(i => i.name === this.config.blocks.scaffold).reduce((a, b) => a + b.count, 0),
      ladder: items.filter(i => i.name === this.config.blocks.ladder).reduce((a, b) => a + b.count, 0),
      oakLeaves: items.filter(i => i.name === this.config.blocks.oakLeaves).reduce((a, b) => a + b.count, 0)
    };
  }
}

module.exports = InventoryManager;
