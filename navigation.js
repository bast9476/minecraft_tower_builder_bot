const { goals } = require('mineflayer-pathfinder');
const vec3 = require('vec3');

class Navigation {
  constructor(bot) {
    this.bot = bot;
  }

  async escapeSpawn() {
    console.log('Executing escape spawn sequence (moving West)...');
    try {
      await this.bot.look(Math.PI / 2, 0, true);
      await this.bot.waitForTicks(2);
      this.bot.setControlState('forward', true);
      await this.bot.waitForTicks(20);
      this.bot.setControlState('forward', false);
      console.log(`Escape spawn complete. Position: ${this.bot.entity.position}`);
    } catch (err) {
      console.error('Escape spawn failed:', err.message);
    }
  }

  async gotoWithTimeout(goal, timeoutMs = 20000) {
    // Escape spawn if we are stuck near the spawn coordinates
    const spawnPos = vec3(-8463.5, 6, 4049.5);
    if (this.bot.entity && this.bot.entity.position) {
      const distToSpawn = this.bot.entity.position.distanceTo(vec3(spawnPos.x, this.bot.entity.position.y, spawnPos.z));
      if (distToSpawn < 1.5) {
        console.log(`[NAVIGATION] Detected bot is near spawn (dist: ${distToSpawn.toFixed(2)}). Escaping spawn first...`);
        await this.escapeSpawn();
      }
    }

    let timeoutId = null;
    try {
      await Promise.race([
        this.bot.pathfinder.goto(goal),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Pathfinding timed out')), timeoutMs);
        })
      ]);
      return true;
    } catch (err) {
      console.error('Pathfinding error:', err.message);
      // Reset pathfinder goal to stop any ongoing movement attempts
      try {
        this.bot.pathfinder.setGoal(null);
      } catch (e) {
        // ignore
      }

      // Fallback teleport if target coordinates are available
      if (goal && typeof goal.x === 'number' && typeof goal.y === 'number' && typeof goal.z === 'number') {
        const tx = goal.x;
        const ty = goal.y;
        const tz = goal.z;
        console.warn(`[NAVIGATION FALLBACK] Pathfinding failed or timed out. Teleporting to target: ${tx}, ${ty}, ${tz}`);
        this.bot.chat(`/tp @s ${tx.toFixed(2)} ${ty.toFixed(2)} ${tz.toFixed(2)}`);
        await this.bot.waitForTicks(10); // Wait 0.5s for chunk loads and teleport to finalize

        // Verify if teleport actually succeeded by checking distance
        const currentPos = this.bot.entity.position;
        const dist = Math.sqrt(Math.pow(currentPos.x - tx, 2) + Math.pow(currentPos.z - tz, 2));
        if (dist < 3.0) {
          console.log(`[NAVIGATION FALLBACK] Teleport verified. Distance to target: ${dist.toFixed(2)}`);
          return true;
        } else {
          console.error(`[NAVIGATION FALLBACK] Teleport failed. Bot is still at ${currentPos}, target was ${tx}, ${ty}, ${tz}`);
          return false;
        }
      }

      return false;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async goto(pos, timeoutMs = 20000) {
    const defaultMove = new goals.GoalNear(pos.x, pos.y, pos.z, 1);
    return this.gotoWithTimeout(defaultMove, timeoutMs);
  }

  async gotoExact(pos, timeoutMs = 20000) {
    const defaultMove = new goals.GoalNear(pos.x, pos.y, pos.z, 0.35);
    return this.gotoWithTimeout(defaultMove, timeoutMs);
  }

  async gotoBlock(pos) {
    const goal = new goals.GoalGetToBlock(pos.x, pos.y, pos.z);
    const success = await this.gotoWithTimeout(goal, 20000);
    if (!success) {
      return this.goto(pos);
    }
    return true;
  }

  findSandstoneBase(config) {
    try {
      const sandstoneBlock = this.bot.registry.blocksByName.sandstone;
      if (!sandstoneBlock) return [];
      const sandstoneId = sandstoneBlock.id;
      const blockPoints = this.bot.findBlocks({
        matching: sandstoneId,
        maxDistance: 64,
        count: 20
      });

      if (config.storageCoordinates) {
        const vec3 = require('vec3');
        const storage = vec3(config.storageCoordinates);
        blockPoints.sort((a, b) => a.distanceTo(storage) - b.distanceTo(storage));
      }
      return blockPoints;
    } catch (err) {
      console.error('Error finding sandstone bases:', err);

      if (config.storageCoordinates) {
        const vec3 = require('vec3');
        return [vec3(config.storageCoordinates.x + 4, config.storageCoordinates.y - 1, config.storageCoordinates.z)];
      }
      return [];
    }
  }
}

module.exports = Navigation;
