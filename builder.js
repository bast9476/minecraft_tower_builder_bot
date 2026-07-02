const vec3 = require('vec3');
const { goals } = require('mineflayer-pathfinder');

class Builder {
  constructor(bot, config, navigation) {
    this.bot = bot;
    this.config = config;
    this.navigation = navigation;
    this.currentBasePos = null;

    console.log("[BUILDER_CONSTRUCTOR] run! Overriding bot.digTime");
    const originalDigTime = bot.digTime;
    bot.digTime = (block) => {
      const time = originalDigTime.call(bot, block);

      return Math.max(250, time + 150);
    };
  }

  async customDig(block, faceVector = vec3(0, 1, 0)) {
    if (!block || block.name === 'air') return;

    if (!this.bot.digTime.__isOverridden) {
      console.log("[CUSTOM_DIG] Overriding bot.digTime dynamically!");
      const originalDigTime = this.bot.digTime;
      const overriddenDigTime = (b) => {
        const time = originalDigTime.call(this.bot, b);
        return Math.max(80, time + 40);
      };
      overriddenDigTime.__isOverridden = true;
      this.bot.digTime = overriddenDigTime;
    }

    const waitTime = this.bot.digTime(block);
    console.log(`[CUSTOM_DIG] Digging block ${block.name} at ${block.position} with waitTime ${waitTime}ms`);

    if (this.bot.targetDigBlock) {
      try { this.bot.stopDigging(); } catch (e) {}
    }

    let faceId = 1;
    if (faceVector) {
      if (faceVector.y < 0) faceId = 0;
      else if (faceVector.y > 0) faceId = 1;
      else if (faceVector.z < 0) faceId = 2;
      else if (faceVector.z > 0) faceId = 3;
      else if (faceVector.x < 0) faceId = 4;
      else if (faceVector.x > 0) faceId = 5;
    }

    this.bot.targetDigBlock = block;
    this.bot.targetDigFace = faceId;

    this.bot.swingArm('right');
    this.bot._client.write('block_dig', {
      status: 0,
      location: block.position,
      face: faceId
    });

    const swingInterval = setInterval(() => {
      this.bot.swingArm('right');
    }, 350);

    await new Promise(resolve => setTimeout(resolve, waitTime));

    clearInterval(swingInterval);
    this.bot._client.write('block_dig', {
      status: 2,
      location: block.position,
      face: faceId
    });

    this.bot.targetDigBlock = null;
    this.bot.targetDigFace = null;

    this.bot._updateBlockState(block.position, 0);

    let verifyTicks = 0;
    while (this.bot.blockAt(block.position)?.name !== 'air' && verifyTicks < 10) {
      await this.bot.waitForTicks(1);
      verifyTicks++;
    }
  }

  async equipItem(itemName, force = false) {
    const item = this.bot.inventory.items().find(i => i.name === itemName);
    if (!item) {
      throw new Error(`Item ${itemName} not found in inventory`);
    }

    const heldItem = this.bot.heldItem;
    if (!force && heldItem && heldItem.name === itemName) {
      return;
    }

    const hotbarIndex = item.slot - 36;
    if (hotbarIndex >= 0 && hotbarIndex < 9) {

      const tempSlot = (hotbarIndex + 1) % 9;
      this.bot.setQuickBarSlot(tempSlot);
      await this.bot.waitForTicks(2);
      this.bot.setQuickBarSlot(hotbarIndex);
      await this.bot.waitForTicks(5);
    } else {
      await this.bot.equip(item, 'hand');
      await this.bot.waitForTicks(5);
    }
  }

  async placeBlockSafely(referenceBlock, faceVector) {
    try {
      const dest = referenceBlock.position.plus(faceVector);
      const oldBlock = this.bot.blockAt(dest);
      const oldType = oldBlock ? oldBlock.type : -1;

      const heldItem = this.bot.heldItem;
      if (heldItem && oldBlock && oldBlock.name === heldItem.name) {
        console.log(`Block at ${dest} is already ${heldItem.name}. Skipping placement.`);
        return true;
      }

      this.bot.setControlState('sneak', true);

      await this.leanTowards(dest.x + 0.5, dest.z + 0.5);

      const dx = 0.5 + faceVector.x * 0.5;
      const dy = 0.5 + faceVector.y * 0.5;
      const dz = 0.5 + faceVector.z * 0.5;
      await this.bot.lookAt(referenceBlock.position.offset(dx, dy, dz), true);

      await this.bot.waitForTicks(1);

      this.bot.swingArm('right');
      await this.bot._genericPlace(referenceBlock, faceVector, {
        forceLook: 'ignore',
        swingArm: undefined
      });

      let verified = false;
      for (let t = 0; t < 10; t++) {
        await this.bot.waitForTicks(1);
        const newBlock = this.bot.blockAt(dest);
        if (newBlock && newBlock.type !== oldType) {
          verified = true;
          break;
        }
      }

      await this.alignToCenter();
      this.bot.setControlState('sneak', false);

      if (verified) {
        console.log(`Successfully placed block against ${referenceBlock.name} at ${referenceBlock.position}`);
        const afterDelay = 1 + Math.floor(Math.random() * 2);
        await this.bot.waitForTicks(afterDelay);
        return true;
      } else {
        console.log(`Block placement not verified at ${dest} (500ms timeout)`);
        return false;
      }
    } catch (err) {
      console.log('Failed to place block:', err.message);

      try {
        await this.alignToCenter();
      } catch (alignErr) {}
      this.bot.setControlState('sneak', false);
      await this.bot.waitForTicks(5);
      return false;
    }
  }

  async equipToolForBlock(block, force = false) {
    let toolName = null;
    if (block.name.includes('dirt') || block.name.includes('grass') || block.name.includes('sand')) {
      toolName = 'shovel';
    } else if (block.name.includes('stone') || block.name.includes('iron') || block.name.includes('bars')) {
      toolName = 'pickaxe';
    } else if (block.name.includes('wood') || block.name.includes('ladder') || block.name.includes('chest')) {
      toolName = 'axe';
    }

    if (toolName) {
      const tool = this.bot.inventory.items().find(i => i.name.includes(toolName));
      if (tool) {
        await this.equipItem(tool.name, force);
      }
    }
  }

  async breakBlockSafely(pos, walkwayY = null) {
    const block = await this.getBlockSafely(pos);
    if (block && block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
      console.log(`Digging block ${block.name} at ${pos}`);

      await this.equipToolForBlock(block, true);
      await this.bot.waitForTicks(1);

      const distance = this.bot.entity.position.distanceTo(pos);
      let leaned = false;
      if (this.currentBasePos && distance > 2.0) {

        this.bot.setControlState('sneak', true);
        await this.leanTowards(pos.x + 0.5, pos.z + 0.5);
        leaned = true;
      } else if (distance > 4) {
        if (walkwayY !== null) {
          await this.navigateToWalkwaySpot(pos, walkwayY);
        } else if (this.currentBasePos) {
          const estimatedWalkwayY = Math.floor(this.bot.entity.position.y) - 1;
          await this.navigateToWalkwaySpot(pos, estimatedWalkwayY);
        } else {
          const goal = new goals.GoalNear(pos.x, pos.y, pos.z, 3);
          let gotoTimeoutId = null;
          try {
            await Promise.race([
              this.bot.pathfinder.goto(goal),
              new Promise((_, reject) => {
                gotoTimeoutId = setTimeout(() => reject(new Error('Pathfinding timed out')), 10000);
              })
            ]);
          } catch (err) {
            console.log(`Pathfinding to block to dig failed: ${err.message}`);
            try { this.bot.pathfinder.setGoal(null); } catch (e) {}
          } finally {
            if (gotoTimeoutId) clearTimeout(gotoTimeoutId);
          }
        }
      }

      const beforeDigDelay = 1;
      await this.bot.waitForTicks(beforeDigDelay);

      try {
        await this.customDig(block, vec3(0, 1, 0));
      } catch (err) {
        console.log(`Failed to dig block at ${pos}: ${err.message}`);
      } finally {
        if (leaned) {
          await this.alignToCenter();
          this.bot.setControlState('sneak', false);
        }
      }
      const afterDigDelay = 1 + Math.floor(Math.random() * 2);
      await this.bot.waitForTicks(afterDigDelay);
    }
  }

  async getBlockSafely(pos) {
    let block = this.bot.blockAt(pos);
    if (block === null) {
      console.log(`Block at ${pos} is not loaded. Waiting for chunk...`);
      for (let i = 0; i < 20; i++) {
        await this.bot.waitForTicks(2);
        block = this.bot.blockAt(pos);
        if (block !== null) {
          console.log(`Chunk loaded at ${pos} after ${i * 2} ticks.`);
          break;
        }
      }
    }
    return block;
  }

  async leanTowards(targetX, targetZ) {
    if (!this.currentBasePos) return;
    const centerX = this.currentBasePos.x + 0.5;
    const centerZ = this.currentBasePos.z + 0.5;

    const dx = targetX - centerX;
    const dz = targetZ - centerZ;
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);

    let destX = centerX;
    let destZ = centerZ;

    if (horizontalDist > 2.0) {

      const shiftDist = 0.42;
      destX = centerX + (dx / horizontalDist) * shiftDist;
      destZ = centerZ + (dz / horizontalDist) * shiftDist;
    }

    this.bot.pathfinder.setGoal(null);
    let ticks = 0;
    let lastPos = this.bot.entity.position.clone();
    while (ticks < 15) {
      const pos = this.bot.entity.position;
      const curDx = destX - pos.x;
      const curDz = destZ - pos.z;
      const dist = Math.sqrt(curDx * curDx + curDz * curDz);

      if (dist < 0.03) {
        break;
      }

      await this.bot.lookAt(vec3(destX, pos.y, destZ), true);
      this.bot.setControlState('sneak', true);
      this.bot.setControlState('forward', true);
      await this.bot.waitForTicks(1);

      const currentPos = this.bot.entity.position;
      if (currentPos.distanceTo(lastPos) < 0.005) {
        break;
      }
      lastPos = currentPos.clone();
      ticks++;
    }
    this.bot.setControlState('forward', false);
  }

  async alignToCenter() {
    const centerX = this.currentBasePos.x + 0.5;
    const centerZ = this.currentBasePos.z + 0.5;

    this.bot.pathfinder.setGoal(null);

    let ticks = 0;
    while (ticks < 40) {
      const pos = this.bot.entity.position;
      const dx = centerX - pos.x;
      const dz = centerZ - pos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < 0.02) {
        break;
      }

      await this.bot.lookAt(vec3(centerX, pos.y, centerZ), true);
      this.bot.setControlState('sneak', true);
      this.bot.setControlState('forward', true);
      await this.bot.waitForTicks(1);
      ticks++;
    }
    this.bot.clearControlStates();
    const finalPos = this.bot.entity.position;
    const finalDist = Math.sqrt(Math.pow(centerX - finalPos.x, 2) + Math.pow(centerZ - finalPos.z, 2));
    console.log(`Aligned to center: final offset dist = ${finalDist.toFixed(4)} (ticks: ${ticks})`);
  }

  async jumpAndPlace(yTarget, blockName) {
    const centerX = this.currentBasePos.x;
    const centerZ = this.currentBasePos.z;
    const posToPlace = vec3(centerX, yTarget, centerZ);

    const currentBlock = this.bot.blockAt(posToPlace);
    if (currentBlock && currentBlock.name === blockName) {
      console.log(`Block at Y=${yTarget} is already ${blockName}.`);
      if (this.bot.entity.position.y < yTarget + 0.5) {
        console.log(`Bot Y (${this.bot.entity.position.y}) is below the block. Jumping to get on top...`);
        this.bot.setControlState('jump', true);
        await this.bot.waitForTicks(10);
        this.bot.setControlState('jump', false);
        let landTicks = 0;
        while (!this.bot.entity.onGround && landTicks < 20) {
          await this.bot.waitForTicks(1);
          landTicks++;
        }
        await this.alignToCenter();
      }
      return true;
    }

    await this.alignToCenter();
    await this.equipItem(blockName);

    for (let attempt = 1; attempt <= 3; attempt++) {

      const check = this.bot.blockAt(posToPlace);
      if (check && check.name === blockName) {
        console.log(`Block at Y=${yTarget} appeared after attempt ${attempt - 1}.`);
        break;
      }

      const blockUnder = await this.getBlockSafely(posToPlace.offset(0, -1, 0));
      if (!blockUnder || blockUnder.name === 'air') {
        throw new Error(`Cannot place block under feet: block under ${posToPlace.offset(0, -1, 0)} is air`);
      }

      this.bot.clearControlStates();

      let waitOnGroundTicks = 0;
      while (!this.bot.entity.onGround && waitOnGroundTicks < 30) {
        await this.bot.waitForTicks(1);
        waitOnGroundTicks++;
      }

      await this.bot.look(this.bot.entity.yaw, -Math.PI / 2, true);
      await this.bot.waitForTicks(3);

      // Jump
      this.bot.setControlState('jump', true);

      // Wait until bot has risen above the block's collision zone (y >= yTarget + 1.0)
      // Place WHILE RISING to maximize the time window before falling back
      let jumpTicks = 0;
      let reachedHeight = false;
      while (jumpTicks < 12) {
        await this.bot.waitForTicks(1);
        if (this.bot.entity.position.y >= yTarget + 1.0) {
          reachedHeight = true;
          break;
        }
        jumpTicks++;
      }

      this.bot.setControlState('jump', false);

      if (!reachedHeight) {
        console.log(`Attempt ${attempt}: Jump didn't reach Y=${yTarget + 1.0}. Current Y: ${this.bot.entity.position.y}`);
        // Wait to land before retrying
        let fallTicks = 0;
        while (!this.bot.entity.onGround && fallTicks < 25) {
          await this.bot.waitForTicks(1);
          fallTicks++;
        }
        await this.bot.waitForTicks(3);
        await this.alignToCenter();
        continue;
      }

      // Send the block placement packet INSTANTLY using _genericPlace with forceLook:'ignore'
      // This skips the internal lookAt async call that adds ~1 tick of delay (causing the bot
      // to fall back into the block's collision zone before the packet is sent).
      try {
        this.bot.swingArm('right');
        await this.bot._genericPlace(blockUnder, vec3(0, 1, 0), {
          forceLook: 'ignore',
          swingArm: undefined
        });
      } catch (err) {
        // _genericPlace only throws if no item is held; packet sending itself doesn't throw
        console.log(`Attempt ${attempt}: _genericPlace error: ${err.message}`);
      }

      // Wait a short time for the server to process and send blockUpdate
      // (much faster than the hardcoded 5000ms in placeBlock)
      let verifyTicks = 0;
      let placed = false;
      while (verifyTicks < 20) { // 20 ticks = 1 second max
        await this.bot.waitForTicks(1);
        const verifyBlock = this.bot.blockAt(posToPlace);
        if (verifyBlock && verifyBlock.name === blockName) {
          placed = true;
          break;
        }
        verifyTicks++;
      }

      if (placed) {
        console.log(`Successfully placed ${blockName} under feet at Y=${yTarget} (attempt ${attempt})`);
        break;
      } else {
        console.log(`Attempt ${attempt}: Block not verified at Y=${yTarget} after 1s.`);
      }

      // Wait to land before retrying
      let landTicks = 0;
      while (!this.bot.entity.onGround && landTicks < 25) {
        await this.bot.waitForTicks(1);
        landTicks++;
      }
      await this.bot.waitForTicks(3);
      await this.alignToCenter();
    }

    // Final verification and stabilization
    const finalBlock = this.bot.blockAt(posToPlace);
    const success = finalBlock && finalBlock.name === blockName;

    // Wait to land
    let landTicks = 0;
    while (!this.bot.entity.onGround && landTicks < 25) {
      await this.bot.waitForTicks(1);
      landTicks++;
    }
    await this.bot.waitForTicks(3);
    await this.alignToCenter();

    const currentY = this.bot.entity.position.y;
    console.log(`After jumpAndPlace, bot Y is ${currentY}`);

    if (!success) {
      console.log(`WARNING: All 3 attempts to place ${blockName} at Y=${yTarget} failed.`);
    }
    return success;
  }

  async descendAndDig(targetY) {
    const centerX = this.currentBasePos.x;
    const centerZ = this.currentBasePos.z;

    console.log(`Descending and digging center column down to Y=${targetY}`);

    // Dig block by block from the bot's current Y down to targetY
    while (Math.floor(this.bot.entity.position.y) > targetY) {
      const currentFeetY = Math.floor(this.bot.entity.position.y);
      const blockToDigPos = vec3(centerX, currentFeetY - 1, centerZ);
      const block = await this.getBlockSafely(blockToDigPos);

      if (block && block.name !== 'air') {
        console.log(`Digging block ${block.name} under feet at ${blockToDigPos}`);

        // Force-equip tool and wait for slot sync before every single dig attempt to avoid slot desync
        await this.equipToolForBlock(block, true);

        // Look at the center of the top face of the block
        const targetLook = blockToDigPos.offset(0.5, 1.0, 0.5);
        await this.bot.lookAt(targetLook, true);
        await this.bot.waitForTicks(2);
        try {
          console.log(`[DESCEND] Starting to dig block ${block.name} at ${blockToDigPos}`);
          const startTime = Date.now();
          // Clear all states before digging to avoid physics/walking desyncs
          this.bot.clearControlStates();

          await this.customDig(block, vec3(0, 1, 0));
          console.log(`[DESCEND] customDig completed. Block is now: ${this.bot.blockAt(blockToDigPos)?.name}`);
        } catch (err) {
          console.log(`[DESCEND] Failed to dig block under feet: ${err.message}`);
        }
      }

      let fallStartTicks = 0;
      while (this.bot.entity.onGround && fallStartTicks < 15) {
        await this.bot.waitForTicks(1);
        fallStartTicks++;
      }

      let landTicks = 0;
      while (!this.bot.entity.onGround && landTicks < 30) {
        await this.bot.waitForTicks(1);
        landTicks++;
      }
      await this.bot.waitForTicks(5);
      await this.alignToCenter();
    }
    console.log(`Bot descended successfully to Y=${this.bot.entity.position.y}`);
    await this.clearCenterColumn(this.currentBasePos);
  }

  async clearCenterColumn(basePos) {
    if (!basePos) return;
    const standPos = vec3(basePos.x + 1.5, basePos.y + 1, basePos.z + 0.5);
    console.log(`[CLEAR_COLUMN] Navigating to adjacent standing position at ${standPos} to clear column...`);
    try {
      await this.navigation.gotoExact(standPos);
    } catch (err) {
      console.log(`[CLEAR_COLUMN] Failed to navigate to standPos: ${err.message}`);
    }
    await this.bot.waitForTicks(5);

    const shovel = this.bot.inventory.items().find(i => i.name.includes('shovel'));
    if (shovel) {
      await this.bot.equip(shovel, 'hand');
      await this.bot.waitForTicks(2);
    }

    const targetDigPos = vec3(basePos.x, basePos.y + 1, basePos.z);
    let digAttempts = 0;
    while (digAttempts < 35) {
      let block = this.bot.blockAt(targetDigPos);
      let waitSolidifyTicks = 0;
      while ((!block || block.name === 'air') && waitSolidifyTicks < 20) {
        let sandAbove = false;
        for (let y = basePos.y + 2; y <= basePos.y + 15; y++) {
          const b = this.bot.blockAt(vec3(basePos.x, y, basePos.z));
          if (b && b.name === this.config.blocks.sand) {
            sandAbove = true;
            break;
          }
        }

        const fallingSand = Object.values(this.bot.entities).some(e => {
          const isFallingBlock = e.name === 'falling_block' || (e.displayName && e.displayName.toLowerCase().includes('falling'));
          if (!isFallingBlock) return false;
          const dx = Math.abs(e.position.x - (basePos.x + 0.5));
          const dz = Math.abs(e.position.z - (basePos.z + 0.5));
          return dx < 0.8 && dz < 0.8 && e.position.y > basePos.y + 1;
        });

        if (!sandAbove && !fallingSand) {
          break;
        }
        await this.bot.waitForTicks(1);
        block = this.bot.blockAt(targetDigPos);
        waitSolidifyTicks++;
      }

      if (block && block.name === this.config.blocks.sand) {
        console.log(`[CLEAR_COLUMN] Digging sand column at Y=${targetDigPos.y} to collapse it... (wait: ${waitSolidifyTicks} ticks)`);
        await this.bot.lookAt(targetDigPos.offset(0.5, 0.5, 0.5), true);
        await this.bot.waitForTicks(2);
        try {
          await this.customDig(block, vec3(0, 1, 0));
        } catch (err) {
          console.log(`[CLEAR_COLUMN] Failed to dig sand column: ${err.message}`);
        }
        await this.bot.waitForTicks(10);
      } else {
        break;
      }
      digAttempts++;
    }
    console.log(`[CLEAR_COLUMN] Center column collapse completed.`);
  }

  async buildLadderScaffold(basePos, targetY) {}
  async removeLadderScaffold(basePos, walkwayY) {}
  async buildWalkway(basePos, Y) {}
  async removeWalkway(basePos, Y) {}
  async buildRoof(basePos, startY) {}
  async cleanupLeftovers(basePos) {}
  async navigateToWalkwaySpot(pos, walkwayY) {
    return true;
  }
  async getWalkwayStandingPosition(pos, walkwayY) {
    return pos;
  }
  async buildFloor(basePos, floorIndex) {
    this.currentBasePos = basePos;
    const startY = basePos.y + 1 + (floorIndex * 4);

    console.log(`Building Floor ${floorIndex + 1} at Y=${startY}`);
    try {

    const pillarOffsets = [
      {dx: -3, dz: -3}, {dx: -1, dz: -3}, {dx: 1, dz: -3}, {dx: 3, dz: -3},
      {dx: -3, dz: -1}, {dx: -1, dz: -1}, {dx: 1, dz: -1}, {dx: 3, dz: -1},
      {dx: -3, dz:  1}, {dx: -1, dz:  1}, {dx: 1, dz:  1}, {dx: 3, dz:  1},
      {dx: -3, dz:  3}, {dx: -1, dz:  3}, {dx: 1, dz:  3}, {dx: 3, dz:  3}
    ];

    const ironOffsets = [
      {dx: -2, dz: -3}, {dx: 2, dz: -3},
      {dx: -2, dz: -1}, {dx: 2, dz: -1},
      {dx: -2, dz:  1}, {dx: 2, dz:  1},
      {dx: -2, dz:  3}, {dx: 2, dz:  3},
      {dx: -3, dz: -2}, {dx: -3, dz:  2},
      {dx:  3, dz: -2}, {dx:  3, dz:  2}
    ];

    if (floorIndex > 0) {
      let missingRefBlocksCount = 0;
      console.log(`VERIFYING PREVIOUS FLOOR AT Y=${startY - 1}:`);
      for (const offset of pillarOffsets) {
        const pos = vec3(basePos.x + offset.dx, startY, basePos.z + offset.dz);
        let refBlock = await this.getBlockSafely(pos.offset(0, -1, 0));
        console.log(`  Verification - Offset (${offset.dx}, ${offset.dz}) at Y=${startY - 1}: name=${refBlock ? refBlock.name : 'null'}, type=${refBlock ? refBlock.type : 'null'}`);
        if (!refBlock || refBlock.name === 'air') {
          missingRefBlocksCount++;
        }
      }
      console.log(`Total missing reference blocks: ${missingRefBlocksCount}`);
      if (missingRefBlocksCount > 4) {
        console.log(`WARNING: Detected ${missingRefBlocksCount}/16 missing reference blocks at Y=${startY - 1} from Floor ${floorIndex}!`);
        throw new Error('previous_floor_missing');
      }
    }

    if (floorIndex === 0 || this.bot.entity.position.y < startY - 0.5) {
      console.log(`Bot Y (${this.bot.entity.position.y}) is below target Y (${startY}) or floorIndex is 0. Resetting/clearing center column to climb...`);

      await this.clearCenterColumn(basePos);

      const centerGoal = vec3(basePos.x + 0.5, basePos.y + 1, basePos.z + 0.5);
      console.log(`Navigating to center column base at ${centerGoal}...`);
      try {
        await this.navigation.gotoExact(centerGoal);
      } catch (err) {
        console.log(`Failed to navigate to centerGoal: ${err.message}`);
      }
      await this.bot.waitForTicks(5);

      console.log(`Center column cleared. Towering up to Y=${startY}...`);
      for (let y = basePos.y + 1; y <= startY; y++) {
        let placed = false;
        let attempts = 0;
        while (!placed && attempts < 5) {
          placed = await this.jumpAndPlace(y, this.config.blocks.sand);
          attempts++;
          if (!placed) await this.bot.waitForTicks(2);
        }
      }
    }

    if (floorIndex === 0) {
      const centerGoal = vec3(basePos.x + 0.5, basePos.y + 1, basePos.z + 0.5);
      await this.navigation.gotoExact(centerGoal);
      await this.bot.waitForTicks(2);
    }

    await this.jumpAndPlace(startY, this.config.blocks.sand);
    await this.equipItem(this.config.blocks.sand);

    console.log(`Step 1: Placing sand pillars at Y=${startY}...`);
    for (const offset of pillarOffsets) {
      const pos = vec3(basePos.x + offset.dx, startY, basePos.z + offset.dz);
      let refBlock = await this.getBlockSafely(pos.offset(0, -1, 0));
      console.log(`  Step 1 - Offset (${offset.dx}, ${offset.dz}) at Y=${startY - 1}: name=${refBlock ? refBlock.name : 'null'}, type=${refBlock ? refBlock.type : 'null'}`);
      if (!refBlock || refBlock.name === 'air') continue;

      await this.equipItem(this.config.blocks.sand);
      let placed = false;
      let attempts = 0;
      while (!placed && attempts < 3) {
        placed = await this.placeBlockSafely(refBlock, vec3(0, 1, 0));
        attempts++;
      }
      if (placed) await this.bot.waitForTicks(1);
    }

    await this.jumpAndPlace(startY + 1, this.config.blocks.sand);
    await this.equipItem(this.config.blocks.cactus);

    for (const offset of pillarOffsets) {
      const pos = vec3(basePos.x + offset.dx, startY + 1, basePos.z + offset.dz);
      let refBlock = await this.getBlockSafely(pos.offset(0, -1, 0));
      if (refBlock && refBlock.name !== 'air') {
        await this.equipItem(this.config.blocks.cactus);
        let placed = false;
        let attempts = 0;
        while (!placed && attempts < 3) {
          placed = await this.placeBlockSafely(refBlock, vec3(0, 1, 0));
          attempts++;
        }
        if (placed) await this.bot.waitForTicks(1);
      }
    }

    for (const offset of pillarOffsets) {
      const pos = vec3(basePos.x + offset.dx, startY + 2, basePos.z + offset.dz);
      const block = await this.getBlockSafely(pos);
      if (block && block.name !== 'air' && block.name !== this.config.blocks.sand) {
        console.log(`Clearing block ${block.name} at ${pos} before placing temp sand`);
        await this.breakBlockSafely(pos);
      }
    }

    await this.equipItem(this.config.blocks.sand);
    for (const offset of pillarOffsets) {
      const pos = vec3(basePos.x + offset.dx, startY + 2, basePos.z + offset.dz);
      let refBlock = await this.getBlockSafely(pos.offset(0, -1, 0));
      if (refBlock && refBlock.name !== 'air') {
        await this.equipItem(this.config.blocks.sand);
        let placed = false;
        let attempts = 0;
        while (!placed && attempts < 3) {
          placed = await this.placeBlockSafely(refBlock, vec3(0, 1, 0));
          attempts++;
        }
        if (placed) await this.bot.waitForTicks(1);
      }
    }

    for (const offset of ironOffsets) {
      const pos = vec3(basePos.x + offset.dx, startY + 2, basePos.z + offset.dz);

      let refBlock = null;
      let faceVector = null;
      const neighbors = [vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 0, 1), vec3(0, 0, -1)];
      const botPos = this.bot.entity.position;
      const candidates = [];
      for (const n of neighbors) {
        const adj = pos.minus(n);
        const b = await this.getBlockSafely(adj);
        if (b && b.name === this.config.blocks.sand) {
          const toBot = botPos.minus(adj);
          const dot = toBot.dot(n);
          candidates.push({ refBlock: b, faceVector: n, dot });
        }
      }
      candidates.sort((a, b) => b.dot - a.dot);
      if (candidates.length > 0) {
        refBlock = candidates[0].refBlock;
        faceVector = candidates[0].faceVector;
      }

      if (refBlock && faceVector) {
        await this.equipItem(this.config.blocks.ironBars);
        let placed = false;
        let attempts = 0;
        while (!placed && attempts < 3) {
          placed = await this.placeBlockSafely(refBlock, faceVector);
          attempts++;
        }
        if (placed) await this.bot.waitForTicks(1);
      }
    }

    for (const offset of pillarOffsets) {
      const pos = vec3(basePos.x + offset.dx, startY + 3, basePos.z + offset.dz);
      const block = await this.getBlockSafely(pos);
      if (block && block.name !== 'air' && block.name !== this.config.blocks.oakLeaves) {
        console.log(`Clearing block ${block.name} at ${pos} before placing oak leaves`);
        await this.breakBlockSafely(pos);
      }
    }

    for (const offset of pillarOffsets) {
      const pos = vec3(basePos.x + offset.dx, startY + 3, basePos.z + offset.dz);
      let refBlock = await this.getBlockSafely(pos.offset(0, -1, 0));
      if (refBlock && refBlock.name !== 'air') {
        await this.equipItem(this.config.blocks.oakLeaves);
        let placed = false;
        let attempts = 0;
        while (!placed && attempts < 3) {
          placed = await this.placeBlockSafely(refBlock, vec3(0, 1, 0));
          attempts++;
        }
        if (placed) await this.bot.waitForTicks(1);
      }
    }

    await this.jumpAndPlace(startY + 2, this.config.blocks.sand);

    const sortedDigOffsets = [...pillarOffsets].sort((a, b) => {
      const distA = a.dx * a.dx + a.dz * a.dz;
      const distB = b.dx * b.dx + b.dz * b.dz;
      return distA - distB;
    });

    for (const offset of sortedDigOffsets) {
      const pos = vec3(basePos.x + offset.dx, startY + 2, basePos.z + offset.dz);
      let tempSandBlock = await this.getBlockSafely(pos);
      if (tempSandBlock && tempSandBlock.name === this.config.blocks.sand) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          tempSandBlock = await this.getBlockSafely(pos);
          if (!tempSandBlock || tempSandBlock.name === 'air') {
            break;
          }

          await this.equipToolForBlock(tempSandBlock, true);

          this.bot.setControlState('sneak', true);

          await this.leanTowards(pos.x + 0.5, pos.z + 0.5);

          const faceVector = vec3(0, 0, 0);
          if (Math.abs(offset.dx) >= Math.abs(offset.dz)) {
            faceVector.x = offset.dx > 0 ? -1 : 1;
          } else {
            faceVector.z = offset.dz > 0 ? -1 : 1;
          }

          const targetLook = pos.offset(0.5, 0.5, 0.5).offset(faceVector.x * 0.5, faceVector.y * 0.5, faceVector.z * 0.5);
          await this.bot.lookAt(targetLook, true);
          await this.bot.waitForTicks(2);

          try {
            console.log(`Digging temporary sand at ${pos} facing ${faceVector} (attempt ${attempt})`);
            await this.customDig(tempSandBlock, faceVector);
            if (this.bot.blockAt(pos)?.name === 'air') {
              break;
            }
          } catch (err) {
            console.log(`Failed to dig temporary sand at ${pos} (attempt ${attempt}): ${err.message}`);
          } finally {

            await this.alignToCenter();
            this.bot.setControlState('sneak', false);
          }
        }
      }
    }

    console.log(`Verifying all temporary sand blocks at Y=${startY + 2} are cleared...`);
    let allTempSandCleared = false;
    for (let cleanAttempt = 1; cleanAttempt <= 3; cleanAttempt++) {
      let remainingSand = [];
      for (const offset of sortedDigOffsets) {
        const pos = vec3(basePos.x + offset.dx, startY + 2, basePos.z + offset.dz);
        const block = await this.getBlockSafely(pos);
        if (block && block.name === this.config.blocks.sand) {
          remainingSand.push({ pos, offset });
        }
      }
      if (remainingSand.length === 0) {
        allTempSandCleared = true;
        console.log("All temporary sand blocks verified as cleared!");
        break;
      }
      console.log(`Warning: Found ${remainingSand.length} remaining temporary sand blocks at Y=${startY + 2}. Cleanup attempt ${cleanAttempt}...`);
      for (const item of remainingSand) {
        const tempSandBlock = await this.getBlockSafely(item.pos);
        if (!tempSandBlock || tempSandBlock.name !== this.config.blocks.sand) continue;
        await this.equipToolForBlock(tempSandBlock, true);

        this.bot.setControlState('sneak', true);

        await this.leanTowards(item.pos.x + 0.5, item.pos.z + 0.5);

        const faceVector = vec3(0, 0, 0);
        if (Math.abs(item.offset.dx) >= Math.abs(item.offset.dz)) {
          faceVector.x = item.offset.dx > 0 ? -1 : 1;
        } else {
          faceVector.z = item.offset.dz > 0 ? -1 : 1;
        }

        const targetLook = item.pos.offset(0.5, 0.5, 0.5).offset(faceVector.x * 0.5, faceVector.y * 0.5, faceVector.z * 0.5);
        await this.bot.lookAt(targetLook, true);
        await this.bot.waitForTicks(2);

        try {
          console.log(`[CLEANUP] Digging temporary sand at ${item.pos} facing ${faceVector}`);
          await this.customDig(tempSandBlock, faceVector);
        } catch (err) {
          console.log(`[CLEANUP] Failed to dig temporary sand at ${item.pos}: ${err.message}`);
        } finally {

          await this.alignToCenter();
          this.bot.setControlState('sneak', false);
        }
      }
    }
    if (!allTempSandCleared) {
      console.log(`WARNING: Failed to clear all temporary sand blocks at Y=${startY + 2} after 3 cleanup attempts.`);
    }

    if (floorIndex < this.config.floorsToBuild - 1) {
      console.log(`Climbing to start of next floor...`);

      for (let y = startY + 3; y <= startY + 4; y++) {
        let placed = false;
        let attempts = 0;
        while (!placed && attempts < 5) {
          placed = await this.jumpAndPlace(y, this.config.blocks.sand);
          attempts++;
          if (!placed) await this.bot.waitForTicks(2);
        }
      }
    } else {
      console.log("Last floor completed. Descending...");
      await this.descendAndDig(basePos.y + 1);
    }
    } catch (err) {
      console.error(`[BUILD_FLOOR_ERROR] Error during floor building: ${err.message}. Cleaning up and descending...`);
      try {
        await this.descendAndDig(basePos.y + 1);
      } catch (descendErr) {
        console.error(`Failed to descend and dig: ${descendErr.message}`);
      }
      throw err;
    }
  }
}

module.exports = Builder;
