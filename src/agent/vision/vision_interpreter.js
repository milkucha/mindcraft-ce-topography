import { botDir } from '../../utils/botpaths.js';
import { Vec3 } from 'vec3';
import { Camera } from "./camera.js";
import fs from 'fs';

export class VisionInterpreter {
    constructor(agent, allow_vision) {
        this.agent = agent;
        this.allow_vision = allow_vision;
        this.fp = botDir(agent.name) + '/screenshots/';
        if (allow_vision) {
            this.camera = new Camera(agent.bot, this.fp);
        }
    }

    async lookAtPlayer(player_name, direction) {
        if (direction !== 'at' && direction !== 'with') {
            return "Invalid direction. Use 'at' or 'with'.";
        }
        const bot = this.agent.bot;
        const player = bot.players[player_name]?.entity;
        if (!player) {
            return `Could not find player ${player_name}`;
        }

        let result;
        if (direction === 'with') {
            await bot.look(player.yaw, player.pitch);
            const deg = ((player.yaw * 180 / Math.PI) % 360 + 360) % 360;
            const facing = deg < 45 || deg >= 315 ? 'south'
                : deg < 135 ? 'west'
                : deg < 225 ? 'north'
                : 'east';
            result = `Looking in the same direction as ${player_name} (facing ${facing})\n`;
        } else {
            await bot.lookAt(new Vec3(player.position.x, player.position.y + player.height, player.position.z));
            result = `Looking at player ${player_name}\n`;
        }

        if (this.allow_vision && this.agent.prompter.vision_model?.sendVisionRequest) {
            const filename = await this.camera.capture();
            result += `Image analysis: "${await this.analyzeImage(filename)}"`;
        }
        return result;
    }

    async lookAtPosition(x, y, z) {
        const bot = this.agent.bot;
        await bot.lookAt(new Vec3(x, y + 2, z));
        let result = `Looking at coordinate ${x}, ${y}, ${z}\n`;

        if (this.allow_vision && this.agent.prompter.vision_model?.sendVisionRequest) {
            const filename = await this.camera.capture();
            result += `Image analysis: "${await this.analyzeImage(filename)}"`;
        }
        return result;
    }

    getCenterBlockInfo() {
        const bot = this.agent.bot;
        const maxDistance = 128; // Maximum distance to check for blocks
        const targetBlock = bot.blockAtCursor(maxDistance);
        
        if (targetBlock) {
            return `Block at center view: ${targetBlock.name} at (${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z})`;
        } else {
            return "No block in center view";
        }
    }

    async analyzeImage(filename) {
        try {
            const imageBuffer = fs.readFileSync(`${this.fp}/${filename}.jpg`);
            const messages = this.agent.history.getHistory();

            const blockInfo = this.getCenterBlockInfo();
            const result = await this.agent.prompter.promptVision(messages, imageBuffer);
            return result + `\n${blockInfo}`;

        } catch (error) {
            console.warn('Error reading image:', error);
            return `Error reading image: ${error.message}`;
        }
    }
} 