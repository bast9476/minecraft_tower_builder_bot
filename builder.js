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
      // Tagged error so the build loop can restock and resume this floor instead
      // of counting it as a tower failure. Keep the item name for diagnostics.
      throw new Error(`out_of_materials:${itemName}`);
    }

    const heldItem = this.bot.heldItem;
    if (!force && heldItem && heldItem.name === itemName && heldItem.count > 0) {
      return;
    }

    const hotbarIndex = item.slot - 36;
    if (hotbarIndex >= 0 && hotbarIndex < 9) {
      this.bot.setQuickBarSlot(hotbarIndex);
      await this.bot.waitForTicks(2);
    } else {
      await this.bot.equip(item, 'hand');
      await this.bot.waitForTicks(3);
    }

    // Double check we are holding the item, retry if desynced
    const doubleCheck = this.bot.heldItem;
    if (!doubleCheck || doubleCheck.name !== itemName || doubleCheck.count <= 0) {
      console.log(`Warning: Equip double check failed for ${itemName}. Retrying equip...`);
      await this.bot.equip(item, 'hand');
      await this.bot.waitForTicks(3);
    }
  }

  async placeBlockSafely(referenceBlock, faceVector, opts = {}) {
    try {
      const dest = referenceBlock.position.plus(faceVector);
      const oldBlock = this.bot.blockAt(dest);
      const oldType = oldBlock ? oldBlock.type : -1;

      const heldItem = this.bot.heldItem;
      if (heldItem && oldBlock && oldBlock.name === heldItem.name) {
        console.log(`Block at ${dest} is already ${heldItem.name}. Skipping placement.`);
        return true;
      }

      this.bot.setControlState('forward', false);
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      this.bot.setControlState('jump', false);
      this.bot.setControlState('sneak', true);

      const leanThreshold = opts.leanThreshold !== undefined ? opts.leanThreshold : 3.5;
      const leanShift = opts.leanShift !== undefined ? opts.leanShift : 0.42;
      const distance = this.bot.entity.position.distanceTo(dest);
      let leaned = false;
      if (this.currentBasePos && distance > leanThreshold) {
        await this.leanTowards(dest.x + 0.5, dest.z + 0.5, leanShift);
        leaned = true;
      }

      // Calculate look/cursor position on the target face. For side faces the
      // component on the face is 1.0 (or 0.0) — right on the block boundary,
      // which servers/anti-cheat can reject. `delta` (when provided) nudges the
      // cursor just inside the face so the placement is unambiguous.
      const delta = opts.delta || vec3(
        0.5 + faceVector.x * 0.5,
        0.5 + faceVector.y * 0.5,
        0.5 + faceVector.z * 0.5
      );
      await this.bot.lookAt(referenceBlock.position.offset(delta.x, delta.y, delta.z), true);

      // Wait 1 tick for the rotation packet to be processed by the server
      await this.bot.waitForTicks(1);

      // For side-face placements (iron bars) force mineflayer to look at the exact
      // face right before sending the packet — top-face placements tolerate
      // 'ignore', but side faces need the look and place in the same instant.
      const forceLook = opts.forceLook !== undefined ? opts.forceLook : 'ignore';
      this.bot.swingArm('right');
      await this.bot._genericPlace(referenceBlock, faceVector, {
        forceLook,
        delta: opts.delta,
        swingArm: undefined
      });

      // Verification loop with 15-tick (750ms) timeout
      let verified = false;
      for (let t = 0; t < 15; t++) {
        await this.bot.waitForTicks(1);
        const newBlock = this.bot.blockAt(dest);
        if (newBlock && newBlock.type !== oldType) {
          verified = true;
          break;
        }
      }

      if (leaned) {
        await this.alignToCenter();
      }
      this.bot.setControlState('sneak', false);

      if (verified) {
        console.log(`Successfully placed block against ${referenceBlock.name} at ${referenceBlock.position}`);
        return true;
      } else {
        console.log(`Block placement not verified at ${dest} (750ms timeout)`);
        return false;
      }
    } catch (err) {
      console.log('Failed to place block:', err.message);

      try {
        await this.alignToCenter();
      } catch (alignErr) {}
      this.bot.setControlState('sneak', false);
      await this.bot.waitForTicks(2);
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

      const distance = this.bot.entity.position.distanceTo(pos);
      let leaned = false;
      if (this.currentBasePos && distance > 4.0) {
        this.bot.setControlState('sneak', true);
        await this.leanTowards(pos.x + 0.5, pos.z + 0.5);
        leaned = true;
      } else if (distance > 4.5) {
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

  async leanTowards(targetX, targetZ, shiftDist = 0.42) {
    if (!this.currentBasePos) return;
    const centerX = this.currentBasePos.x + 0.5;
    const centerZ = this.currentBasePos.z + 0.5;

    const dx = targetX - centerX;
    const dz = targetZ - centerZ;
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);

    let destX = centerX;
    let destZ = centerZ;

    if (horizontalDist > 2.0) {
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

  // ---------------------------------------------------------------------------
  // Layer-completion helpers.
  //
  // Every layer of a floor is placed against the layer directly below it. If a
  // single block is missed, the block above it loses its reference and gets
  // skipped too, cascading up the whole column. These helpers guarantee a layer
  // is 100% complete (via bounded repair rounds) before the caller moves on, so
  // no cascade can ever start. Nothing is skipped silently: any block that
  // remains missing after all rounds is logged with its exact offset.
  // ---------------------------------------------------------------------------

  // Place `itemName` at every `offset` on plane Y, each against the block below
  // it. Re-scans and re-places until the layer is complete or rounds run out.
  async placeVerticalLayer(basePos, y, offsets, itemName, opts = {}) {
    const maxRounds = opts.maxRounds || 4;
    const attemptsPerBlock = opts.attemptsPerBlock || 5;
    const label = `[LAYER ${itemName} @Y=${y}]`;

    let prevMissingCount = -1;
    for (let round = 1; round <= maxRounds; round++) {
      let placedCount = 0;
      const missing = [];
      const missingRef = [];

      for (const offset of offsets) {
        const dest = vec3(basePos.x + offset.dx, y, basePos.z + offset.dz);

        const existing = this.bot.blockAt(dest);
        if (existing && existing.name === itemName) {
          placedCount++;
          continue;
        }

        const refBlock = await this.getBlockSafely(dest.offset(0, -1, 0));
        if (!refBlock || refBlock.name === 'air') {
          missing.push(offset);
          missingRef.push(offset);
          continue;
        }

        let placed = false;
        let attempts = 0;
        while (!placed && attempts < attemptsPerBlock) {
          await this.equipItem(itemName);
          placed = await this.placeBlockSafely(refBlock, vec3(0, 1, 0));
          attempts++;
        }

        if (placed) placedCount++;
        else missing.push(offset);
      }

      console.log(`${label} round ${round}: ${placedCount}/${offsets.length} placed, ${missing.length} missing`);
      if (missingRef.length > 0) {
        console.log(`${label} note: ${missingRef.length} block(s) had a MISSING reference below: ${missingRef.map(o => `(${o.dx},${o.dz})`).join(', ')}`);
      }

      if (missing.length === 0) return { ok: true, missing: [] };

      // Stop early if a full round made no progress (avoids spinning forever).
      if (missing.length === prevMissingCount) {
        console.log(`${label} no progress in round ${round}; stopping repair rounds.`);
        break;
      }
      prevMissingCount = missing.length;
    }

    const stillMissing = [];
    for (const offset of offsets) {
      const b = this.bot.blockAt(vec3(basePos.x + offset.dx, y, basePos.z + offset.dz));
      if (!b || b.name !== itemName) stillMissing.push(offset);
    }
    if (stillMissing.length > 0) {
      console.log(`${label} WARNING: ${stillMissing.length} block(s) STILL MISSING after ${maxRounds} rounds: ${stillMissing.map(o => `(${o.dx},${o.dz})`).join(', ')}`);
      return { ok: false, missing: stillMissing };
    }
    return { ok: true, missing: [] };
  }

  // Place iron bars at every `offset` on plane Y against the best horizontally
  // adjacent sand block (picking the neighbor facing the bot for reach). Same
  // bounded repair-round structure as placeVerticalLayer.
  async placeIronBarsLayer(basePos, y, ironOffsets, opts = {}) {
    const maxRounds = opts.maxRounds || 4;
    const attemptsPerBlock = opts.attemptsPerBlock || 5;
    const ironName = this.config.blocks.ironBars;
    const label = `[LAYER ${ironName} @Y=${y}]`;
    const neighbors = [vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 0, 1), vec3(0, 0, -1)];

    let prevMissingCount = -1;
    for (let round = 1; round <= maxRounds; round++) {
      let placedCount = 0;
      const missing = [];

      for (const offset of ironOffsets) {
        const pos = vec3(basePos.x + offset.dx, y, basePos.z + offset.dz);

        const existing = this.bot.blockAt(pos);
        if (existing && existing.name === ironName) {
          placedCount++;
          continue;
        }

        const botPos = this.bot.entity.position;
        const candidates = [];
        for (const n of neighbors) {
          const adj = pos.minus(n);
          const b = await this.getBlockSafely(adj);
          if (b && b.name === this.config.blocks.sand) {
            const toBot = botPos.minus(adj);
            candidates.push({ refBlock: b, faceVector: n, dot: toBot.dot(n) });
          }
        }
        candidates.sort((a, b) => b.dot - a.dot);

        if (candidates.length === 0) {
          missing.push(offset);
          continue;
        }

        let placed = false;
        let attempts = 0;
        while (!placed && attempts < attemptsPerBlock) {
          // Fall back to the next-best neighbor on repeated failure.
          const cand = candidates[Math.min(attempts, candidates.length - 1)];
          const fv = cand.faceVector;
          // Cursor nudged just inside the face (0.95/0.05 instead of 1.0/0.0).
          const delta = vec3(
            0.5 + fv.x * 0.45,
            0.5 + fv.y * 0.45,
            0.5 + fv.z * 0.45
          );
          await this.equipItem(ironName);
          placed = await this.placeBlockSafely(cand.refBlock, fv, {
            delta,
            forceLook: true,
            leanThreshold: 2.5,
            leanShift: 0.5 // lean further out — reach from the raised (higher) stance is tighter
          });
          attempts++;
        }

        if (placed) placedCount++;
        else missing.push(offset);
      }

      console.log(`${label} round ${round}: ${placedCount}/${ironOffsets.length} placed, ${missing.length} missing`);

      if (missing.length === 0) return { ok: true, missing: [] };
      if (missing.length === prevMissingCount) {
        console.log(`${label} no progress in round ${round}; stopping repair rounds.`);
        break;
      }
      prevMissingCount = missing.length;
    }

    const stillMissing = [];
    for (const offset of ironOffsets) {
      const b = this.bot.blockAt(vec3(basePos.x + offset.dx, y, basePos.z + offset.dz));
      if (!b || b.name !== ironName) stillMissing.push(offset);
    }
    if (stillMissing.length > 0) {
      console.log(`${label} WARNING: ${stillMissing.length} iron bar(s) STILL MISSING after ${maxRounds} rounds: ${stillMissing.map(o => `(${o.dx},${o.dz})`).join(', ')}`);
      return { ok: false, missing: stillMissing };
    }
    return { ok: true, missing: [] };
  }

  // Scan the four permanent layers of a finished floor and report completeness.
  // Report-only: by the time a floor is done the temporary sand references for
  // the upper layers have been removed, so blocks can't be re-placed from here
  // anyway — the per-layer repair rounds above are what guarantee completion at
  // build time. This is the visibility net so a shortfall is never silent.
  async auditFloor(basePos, floorIndex) {
    const startY = basePos.y + 1 + (floorIndex * 4);
    const { sand, cactus, ironBars, oakLeaves } = this.config.blocks;

    const pillarOffsets = [
      {dx: -3, dz: -3}, {dx: -1, dz: -3}, {dx: 1, dz: -3}, {dx: 3, dz: -3},
      {dx: -3, dz: -1}, {dx: -1, dz: -1}, {dx: 1, dz: -1}, {dx: 3, dz: -1},
      {dx: -3, dz:  1}, {dx: -1, dz:  1}, {dx: 1, dz:  1}, {dx: 3, dz:  1},
      {dx: -3, dz:  3}, {dx: -1, dz:  3}, {dx: 1, dz:  3}, {dx: 3, dz:  3}
    ];
    const ironOffsets = [
      {dx: -2, dz: -3}, {dx: 2, dz: -3}, {dx: -2, dz: -1}, {dx: 2, dz: -1},
      {dx: -2, dz:  1}, {dx: 2, dz:  1}, {dx: -2, dz:  3}, {dx: 2, dz:  3},
      {dx: -3, dz: -2}, {dx: -3, dz:  2}, {dx:  3, dz: -2}, {dx:  3, dz:  2}
    ];

    const countLayer = async (y, offsets, name) => {
      let present = 0;
      const missing = [];
      for (const o of offsets) {
        const b = await this.getBlockSafely(vec3(basePos.x + o.dx, y, basePos.z + o.dz));
        if (b && b.name === name) present++;
        else missing.push(o);
      }
      return { present, total: offsets.length, missing };
    };

    const pillars = await countLayer(startY, pillarOffsets, sand);
    const cactusR = await countLayer(startY + 1, pillarOffsets, cactus);
    const ironR = await countLayer(startY + 2, ironOffsets, ironBars);
    const leavesR = await countLayer(startY + 3, pillarOffsets, oakLeaves);

    console.log(`Floor ${floorIndex + 1} audit: pillars ${pillars.present}/${pillars.total}, cactus ${cactusR.present}/${cactusR.total}, iron ${ironR.present}/${ironR.total}, leaves ${leavesR.present}/${leavesR.total}`);

    const fmt = (o) => `(${o.dx},${o.dz})`;
    const shortfalls = [];
    if (pillars.missing.length) shortfalls.push(`sand@${startY}: ${pillars.missing.map(fmt).join(',')}`);
    if (cactusR.missing.length) shortfalls.push(`cactus@${startY + 1}: ${cactusR.missing.map(fmt).join(',')}`);
    if (ironR.missing.length) shortfalls.push(`iron@${startY + 2}: ${ironR.missing.map(fmt).join(',')}`);
    if (leavesR.missing.length) shortfalls.push(`leaves@${startY + 3}: ${leavesR.missing.map(fmt).join(',')}`);

    if (shortfalls.length) {
      console.log(`Floor ${floorIndex + 1} audit WARNING — incomplete layers: ${shortfalls.join(' | ')}`);
      return false;
    }
    console.log(`Floor ${floorIndex + 1} audit: COMPLETE.`);
    return true;
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
    await this.placeVerticalLayer(basePos, startY, pillarOffsets, this.config.blocks.sand);

    await this.jumpAndPlace(startY + 1, this.config.blocks.sand);

    console.log(`Step 2: Placing cactus at Y=${startY + 1}...`);
    await this.placeVerticalLayer(basePos, startY + 1, pillarOffsets, this.config.blocks.cactus);

    for (const offset of pillarOffsets) {
      const pos = vec3(basePos.x + offset.dx, startY + 2, basePos.z + offset.dz);
      const block = await this.getBlockSafely(pos);
      if (block && block.name !== 'air' && block.name !== this.config.blocks.sand) {
        console.log(`Clearing block ${block.name} at ${pos} before placing temp sand`);
        await this.breakBlockSafely(pos);
      }
    }

    // Temp sand is the reference for BOTH the iron bars (horizontal neighbor)
    // and the oak leaves (block below), so it must be complete before either.
    console.log(`Step 3: Placing temporary sand at Y=${startY + 2}...`);
    await this.placeVerticalLayer(basePos, startY + 2, pillarOffsets, this.config.blocks.sand);

    // Place iron bars first while the leaves at Y=88 are not placed yet,
    // ensuring a completely clear line of sight to the Y=87 sand faces.
    console.log(`Step 4: Placing iron bars at Y=${startY + 2}...`);
    await this.placeIronBarsLayer(basePos, startY + 2, ironOffsets);

    // Now raise the bot to feet Y=${startY + 3} (by placing sand in the center column at Y=${startY + 2})
    // BEFORE placing the leaves ring at Y=${startY + 3}. This brings the corner leaf targets
    // (distance 4.07 blocks) within comfortable reach of the server's reach check.
    console.log(`Raising to feet Y=${startY + 3} for leaves placement and cleanup...`);
    await this.jumpAndPlace(startY + 2, this.config.blocks.sand);

    for (const offset of pillarOffsets) {
      const pos = vec3(basePos.x + offset.dx, startY + 3, basePos.z + offset.dz);
      const block = await this.getBlockSafely(pos);
      if (block && block.name !== 'air' && block.name !== this.config.blocks.oakLeaves) {
        console.log(`Clearing block ${block.name} at ${pos} before placing oak leaves`);
        await this.breakBlockSafely(pos);
      }
    }

    console.log(`Step 5: Placing oak leaves at Y=${startY + 3}...`);
    await this.placeVerticalLayer(basePos, startY + 3, pillarOffsets, this.config.blocks.oakLeaves);

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

          const distance = this.bot.entity.position.distanceTo(pos);
          let leaned = false;
          if (distance > 4.0) {
            await this.leanTowards(pos.x + 0.5, pos.z + 0.5);
            leaned = true;
          }

          const faceVector = vec3(0, 0, 0);
          if (Math.abs(offset.dx) >= Math.abs(offset.dz)) {
            faceVector.x = offset.dx > 0 ? -1 : 1;
          } else {
            faceVector.z = offset.dz > 0 ? -1 : 1;
          }

          const targetLook = pos.offset(0.5, 0.5, 0.5).offset(faceVector.x * 0.5, faceVector.y * 0.5, faceVector.z * 0.5);
          await this.bot.lookAt(targetLook, true);
          await this.bot.waitForTicks(1);

          try {
            console.log(`Digging temporary sand at ${pos} facing ${faceVector} (attempt ${attempt})`);
            await this.customDig(tempSandBlock, faceVector);
            if (this.bot.blockAt(pos)?.name === 'air') {
              break;
            }
          } catch (err) {
            console.log(`Failed to dig temporary sand at ${pos} (attempt ${attempt}): ${err.message}`);
          } finally {
            if (leaned) {
              await this.alignToCenter();
            }
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

        const distance = this.bot.entity.position.distanceTo(item.pos);
        let leaned = false;
        if (distance > 4.0) {
          await this.leanTowards(item.pos.x + 0.5, item.pos.z + 0.5);
          leaned = true;
        }

        const faceVector = vec3(0, 0, 0);
        if (Math.abs(item.offset.dx) >= Math.abs(item.offset.dz)) {
          faceVector.x = item.offset.dx > 0 ? -1 : 1;
        } else {
          faceVector.z = item.offset.dz > 0 ? -1 : 1;
        }

        const targetLook = item.pos.offset(0.5, 0.5, 0.5).offset(faceVector.x * 0.5, faceVector.y * 0.5, faceVector.z * 0.5);
        await this.bot.lookAt(targetLook, true);
        await this.bot.waitForTicks(1);

        try {
          console.log(`[CLEANUP] Digging temporary sand at ${item.pos} facing ${faceVector}`);
          await this.customDig(tempSandBlock, faceVector);
        } catch (err) {
          console.log(`[CLEANUP] Failed to dig temporary sand at ${item.pos}: ${err.message}`);
        } finally {
          if (leaned) {
            await this.alignToCenter();
          }
          this.bot.setControlState('sneak', false);
        }
      }
    }
    if (!allTempSandCleared) {
      console.log(`WARNING: Failed to clear all temporary sand blocks at Y=${startY + 2} after 3 cleanup attempts.`);
    }

    // Final visibility net: confirm every permanent block of this floor is present.
    await this.auditFloor(basePos, floorIndex);

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
      // Out of materials: don't tear down the center column (descendAndDig needs
      // a shovel and wastes progress). Bubble up — the loop restocks and re-runs
      // this same floor, which resumes idempotently (placed blocks are skipped).
      if (err.message && err.message.startsWith('out_of_materials')) {
        console.warn(`[BUILD_FLOOR] Out of materials mid-floor (${err.message}). Restocking and resuming this floor.`);
        try { this.bot.clearControlStates(); } catch (e) {}
        throw err;
      }
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
