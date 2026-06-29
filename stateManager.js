const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'state.json');

class StateManager {
  constructor() {
    this.state = this.loadState();
  }

  loadState() {
    if (fs.existsSync(STATE_FILE)) {
      try {
        const data = fs.readFileSync(STATE_FILE, 'utf8');
        return JSON.parse(data);
      } catch (err) {
        console.error('Error loading state:', err);
      }
    }
    return {
      completedTowers: [],
      currentTower: null,
      currentFloor: 0,
      currentStep: 0,
    };
  }

  saveState() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error('Error saving state:', err);
    }
  }

  isTowerCompleted(pos) {
    return this.state.completedTowers.some(t => t.x === pos.x && t.y === pos.y && t.z === pos.z);
  }

  markTowerCompleted(pos) {
    if (!this.isTowerCompleted(pos)) {
      this.state.completedTowers.push(pos);
      this.state.currentTower = null;
      this.state.currentFloor = 0;
      this.state.currentStep = 0;
      this.saveState();
    }
  }

  setCurrentTower(pos) {
    if (this.state.currentTower && this.state.currentTower.x === pos.x && this.state.currentTower.y === pos.y && this.state.currentTower.z === pos.z) {
      return;
    }
    this.state.currentTower = pos;
    this.state.currentFloor = 0;
    this.state.currentStep = 0;
    this.saveState();
  }

  updateProgress(floor, step) {
    this.state.currentFloor = floor;
    this.state.currentStep = step;
    this.saveState();
  }

  getProgress() {
    return {
      currentTower: this.state.currentTower,
      currentFloor: this.state.currentFloor,
      currentStep: this.state.currentStep,
      completedTowers: this.state.completedTowers.length
    };
  }
}

module.exports = new StateManager();
