import Vec3 from 'vec3';
import * as skills from './skills.js';
import { isWaterBlock, planBridge, snapDirection } from './bridge_plan.js';

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);

function surfaceAt(bot, x, z, maxY = 120) {
    for (let y = maxY; y >= 0; y--) {
        const block = bot.blockAt(new Vec3(x, y, z));
        if (!block)
            continue;
        if (AIR_BLOCKS.has(block.name))
            continue;
        return { y, name: block.name, water: isWaterBlock(block.name) };
    }
    return null;
}

export async function buildBridge(agent, player_name) {
    const bot = agent.bot;
    const player = bot.players[player_name]?.entity;
    if (!player) {
        const message = `Could not find player ${player_name}.`;
        skills.log(bot, message);
        return message;
    }

    const start = {
        x: Math.floor(player.position.x),
        z: Math.floor(player.position.z)
    };
    const dir = snapDirection(player.yaw);
    const maxY = Math.max(120, Math.floor(player.position.y) + 20);
    const getSurface = (x, z) => surfaceAt(bot, x, z, maxY);
    const plan = planBridge({ getSurface, start, dir });

    if (plan.error) {
        skills.log(bot, plan.error);
        return plan.error;
    }

    const directionName = dir.x === 1 ? 'east' : dir.x === -1 ? 'west'
        : dir.z === 1 ? 'south' : 'north';
    skills.log(bot,
        `Bridge plan: ${plan.length} water columns ${directionName}, deck y=${plan.deckY} ` +
        `(water y=${plan.waterY}), pillars every ${plan.spacing} columns, railings both sides.`
    );

    const placements = [
        ...(plan.landingSupports || []).map(p => ({ ...p, stage: 'support' })),
        ...(plan.stairSupports || []).map(p => ({ ...p, stage: 'support' })),
        ...plan.landings.map(p => ({ ...p, stage: 'landing' })),
        ...plan.stairs.map(p => ({ ...p, stage: 'stairs' })),
        ...plan.deck.map(p => ({ ...p, stage: 'deck' })),
        ...plan.pillars.map(p => ({ ...p, stage: 'pillar' })),
        ...plan.railings.map(p => ({ ...p, stage: 'railing' })),
    ];

    const creative = bot.game.gameMode === 'creative' && bot.creative?.flyTo;
    const moveTo = async (x, y, z) => {
        if (creative) {
            try {
                await bot.creative.flyTo(new Vec3(x, y + 2, z));
                return;
            } catch {
                // fall through to walking
            }
        }
        await skills.goToPosition(bot, x, y, z, 1);
    };

    const placed = [];
    const failed = [];
    if (!creative)
        await skills.goToPlayer(bot, player_name, 2);

    for (const target of placements) {
        await moveTo(target.x, target.y, target.z);
        const ok = await skills.placeBlock(
            bot, target.block, target.x, target.y, target.z, 'bottom', true
        );
        if (ok)
            placed.push(target);
        else
            failed.push(`${target.block}@${target.x},${target.y},${target.z}`);
    }

    if (creative) {
        try {
            await bot.creative.flyTo(new Vec3(player.position.x, player.position.y + 2, player.position.z));
            bot.creative.stopFlying();
        } catch {
            // leave the bot where it is
        }
    }

    // Verify the deck columns directly against the world.
    const gaps = [];
    for (const column of plan.deck) {
        const block = bot.blockAt(new Vec3(column.x, column.y, column.z));
        if (!block || block.name !== column.block)
            gaps.push(`(${column.x},${column.y},${column.z})`);
    }

    const count = stage => placed.filter(p => p.stage === stage).length;
    const supportCount = (plan.landingSupports?.length || 0) + (plan.stairSupports?.length || 0);
    const summary =
        `Bridge: water ${plan.length} columns, deck y=${plan.deckY}; ` +
        `deck ${count('deck')}/${plan.deck.length}, ` +
        `pillars ${count('pillar')}/${plan.pillars.length}, ` +
        `railings ${count('railing')}/${plan.railings.length}, ` +
        `landings ${count('landing')}/${plan.landings.length}, ` +
        `stairs ${count('stairs')}/${plan.stairs.length}, ` +
        `supports ${count('support')}/${supportCount}. ` +
        (gaps.length ? `GAPS: ${gaps.join(' ')}` : 'No deck gaps.');
    if (failed.length)
        skills.log(bot, `Bridge placement failures (${failed.length}): ${failed.slice(0, 8).join(', ')}`);
    skills.log(bot, summary);
    return summary;
}
