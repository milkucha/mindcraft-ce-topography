import * as bridge from '../library/bridge.js';

export const buildingList = [
    {
        name: '!buildBridge',
        description: 'Build a bridge across the water in front of the player. The player must stand on the shore facing the water. Builds a deck at least one block above the water, with pillars, railings, landings, and stairs.',
        params: {
            'player_name': { type: 'string', description: 'Name of the player standing on the shore facing the water.' }
        },
        perform: async function (agent, player_name) {
            const code_return = await agent.actions.runAction('action:buildBridge', async () => {
                await bridge.buildBridge(agent, player_name);
            });
            if (code_return.interrupted && !code_return.timedout)
                return;
            return code_return.message;
        }
    }
];
