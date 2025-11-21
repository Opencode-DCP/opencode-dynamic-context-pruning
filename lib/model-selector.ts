/**
 * Model Selection and Fallback Logic
 * 
 * This module handles intelligent model selection for the DCP plugin's analysis tasks.
 * It attempts to use the same model as the current session, with cascading fallbacks
 * to faster/cheaper alternatives when needed.
 */

import type { LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { OpencodeAI } from '@tarquinen/opencode-auth-provider';
import type { Logger } from './logger';

export interface ModelInfo {
    providerID: string;
    modelID: string;
}

export interface ModelTierConfig {
    tier1Models: string[]; // Primary models (expensive, high-quality)
    tier2Models: string[]; // Fast fallback models (cheaper, faster)
}

/**
 * Model tier mappings for each provider
 * Tier 1: High-quality models
 * Tier 2: Fast, cost-effective alternatives
 */
export const MODEL_TIERS: Record<string, ModelTierConfig> = {
    openai: {
        tier1Models: ['gpt-5.1-codex', 'gpt-5.1', 'gpt-5', 'gpt-4o', 'gpt-4-turbo'],
        tier2Models: ['gpt-5.1-codex-mini', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1-mini', 'gpt-4o-mini', 'gpt-3.5-turbo']
    },
    anthropic: {
        tier1Models: ['claude-sonnet-4.5', 'claude-sonnet-4', 'claude-opus-4.1', 'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229'],
        tier2Models: ['claude-haiku-4-5', 'claude-3-5-haiku-20241022', 'claude-3-haiku-20240307']
    },
    google: {
        tier1Models: ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.0-pro', 'gemini-1.5-pro'],
        tier2Models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-flash-8b']
    },
    deepseek: {
        tier1Models: ['deepseek-r1', 'deepseek-v3.1', 'deepseek-reasoner', 'deepseek-coder'],
        tier2Models: ['deepseek-chat']
    },
    xai: {
        tier1Models: ['grok-4', 'grok-code-fast-1', 'grok-3'],
        tier2Models: ['grok-4-fast', 'grok-3-mini', 'grok-2-mini']
    },
    qwen: {
        tier1Models: ['qwen3-coder-480b', 'qwen3-max', 'qwen2.5-coder-32b'],
        tier2Models: ['qwen3-coder-flash', 'qwen-flash', 'qwen-turbo']
    },
    zhipu: {
        tier1Models: ['glm-4.6', 'glm-4.5', 'glm-4'],
        tier2Models: ['glm-4.5-air', 'glm-4.5-flash', 'glm-4-flash']
    },
    // Default fallback - no auth required
    bigpickle: {
        tier1Models: ['big-pickle'],
        tier2Models: ['big-pickle']
    }
};

/**
 * Provider priority order for fallback selection
 * Providers earlier in the list are preferred over later ones
 */
const PROVIDER_PRIORITY = [
    'openai',
    'anthropic',
    'google',
    'deepseek',
    'xai',
    'qwen',
    'zhipu',
    'bigpickle'
];

export interface ModelSelectionResult {
    model: LanguageModel;
    modelInfo: ModelInfo;
    tier: 'primary' | 'tier2-same-provider' | 'tier2-other-provider' | 'fallback';
    reason?: string;
}

/**
 * Gets a tier 2 (fast) model for a given provider
 */
function getTier2Model(providerID: string): string | null {
    const config = MODEL_TIERS[providerID.toLowerCase()];
    if (!config || config.tier2Models.length === 0) {
        return null;
    }
    return config.tier2Models[0];
}

/**
 * Checks if a model belongs to tier 1 (primary) for a provider
 */
function isTier1Model(providerID: string, modelID: string): boolean {
    const config = MODEL_TIERS[providerID.toLowerCase()];
    if (!config) return false;
    return config.tier1Models.some(m => modelID.toLowerCase().includes(m.toLowerCase()));
}

/**
 * Gets the fallback big-pickle model (no auth required)
 */
function getBigPickleModel(): LanguageModel {
    const bigPickle = createOpenAICompatible({
        name: 'big-pickle',
        baseURL: 'https://models.fly.dev/v1',
    });
    return bigPickle('big-pickle');
}

/**
 * Main model selection function with intelligent fallback logic
 * 
 * Selection hierarchy:
 * 1. Try the config-specified model (if provided)
 * 2. Try the current session's model
 * 3. If tier 1, fall back to tier 2 from same provider
 * 4. Try tier 2 models from other authenticated providers
 * 5. Ultimate fallback to big-pickle (free, no auth)
 * 
 * @param currentModel - The model being used in the current session (optional)
 * @param logger - Logger instance for debug output
 * @param configModel - Model string in "provider/model" format (e.g., "anthropic/claude-haiku-4-5")
 * @returns Selected model with metadata about the selection
 */
export async function selectModel(
    currentModel?: ModelInfo, 
    logger?: Logger,
    configModel?: string
): Promise<ModelSelectionResult> {
    logger?.info('model-selector', 'Model selection started', { currentModel, configModel });
    const opencodeAI = new OpencodeAI();

    // Step 0: Try to use the config-specified model if provided
    if (configModel) {
        const parts = configModel.split('/')
        if (parts.length !== 2) {
            logger?.warn('model-selector', '✗ Invalid config model format, expected "provider/model"', {
                configModel
            });
        } else {
            const [providerID, modelID] = parts
            logger?.debug('model-selector', 'Step 0: Attempting to use config-specified model', {
                providerID,
                modelID
            });

            try {
                const model = await opencodeAI.getLanguageModel(providerID, modelID);
                logger?.info('model-selector', '✓ Successfully using config-specified model', {
                    providerID,
                    modelID
                });
                return {
                    model,
                    modelInfo: { providerID, modelID },
                    tier: 'primary',
                    reason: 'Using model specified in dcp.jsonc config'
                };
            } catch (error: any) {
                // Log warning but continue to fallback logic
                logger?.warn('model-selector', '✗ Failed to use config-specified model, falling back', {
                    providerID,
                    modelID,
                    error: error.message
                });
            }
        }
    }

    // Step 1: Try to use the current session's model
    if (currentModel) {
        logger?.debug('model-selector', 'Step 1: Attempting to use current session model', {
            providerID: currentModel.providerID,
            modelID: currentModel.modelID
        });

        try {
            const model = await opencodeAI.getLanguageModel(currentModel.providerID, currentModel.modelID);
            logger?.info('model-selector', '✓ Successfully using current session model', {
                providerID: currentModel.providerID,
                modelID: currentModel.modelID
            });
            return {
                model,
                modelInfo: currentModel,
                tier: 'primary',
                reason: 'Using current session model'
            };
        } catch (error: any) {
            // Continue to fallback logic
            logger?.warn('model-selector', '✗ Failed to use session model', {
                providerID: currentModel.providerID,
                modelID: currentModel.modelID,
                error: error.message
            });
        }

        // Step 2: If current model is tier 1, try tier 2 from same provider
        const isTier1 = isTier1Model(currentModel.providerID, currentModel.modelID);
        logger?.debug('model-selector', 'Checking if current model is tier 1', {
            providerID: currentModel.providerID,
            modelID: currentModel.modelID,
            isTier1
        });

        if (isTier1) {
            const tier2ModelID = getTier2Model(currentModel.providerID);
            logger?.debug('model-selector', 'Step 2: Attempting tier 2 fallback from same provider', {
                providerID: currentModel.providerID,
                tier2ModelID
            });

            if (tier2ModelID) {
                try {
                    const model = await opencodeAI.getLanguageModel(currentModel.providerID, tier2ModelID);
                    logger?.info('model-selector', '✓ Successfully using tier 2 model from same provider', {
                        providerID: currentModel.providerID,
                        modelID: tier2ModelID
                    });
                    return {
                        model,
                        modelInfo: { providerID: currentModel.providerID, modelID: tier2ModelID },
                        tier: 'tier2-same-provider',
                        reason: `Falling back to faster model from same provider: ${tier2ModelID}`
                    };
                } catch (error: any) {
                    logger?.warn('model-selector', '✗ Failed to use tier 2 model from same provider', {
                        providerID: currentModel.providerID,
                        modelID: tier2ModelID,
                        error: error.message
                    });
                }
            } else {
                logger?.debug('model-selector', 'No tier 2 model available for provider', {
                    providerID: currentModel.providerID
                });
            }
        }
    } else {
        logger?.debug('model-selector', 'No current session model provided, skipping steps 1-2');
    }

    // Step 3: Try tier 2 models from other authenticated providers
    logger?.debug('model-selector', 'Step 3: Fetching available authenticated providers');
    const providers = await opencodeAI.listProviders();
    const availableProviderIDs = Object.keys(providers);
    logger?.info('model-selector', 'Available authenticated providers', {
        providerCount: availableProviderIDs.length,
        providerIDs: availableProviderIDs,
        providers: Object.entries(providers).map(([id, info]) => ({
            id,
            source: info.source,
            name: info.info.name
        }))
    });

    logger?.debug('model-selector', 'Attempting tier 2 models from other providers', {
        priorityOrder: PROVIDER_PRIORITY,
        currentProvider: currentModel?.providerID
    });

    for (const providerID of PROVIDER_PRIORITY) {
        if (providerID === 'bigpickle') {
            logger?.debug('model-selector', 'Skipping bigpickle (saving for final fallback)');
            continue;
        }

        if (currentModel && providerID === currentModel.providerID) {
            logger?.debug('model-selector', `Skipping ${providerID} (already tried as current provider)`);
            continue;
        }

        if (!providers[providerID]) {
            logger?.debug('model-selector', `Skipping ${providerID} (not authenticated)`);
            continue;
        }

        const tier2ModelID = getTier2Model(providerID);
        if (!tier2ModelID) {
            logger?.debug('model-selector', `Skipping ${providerID} (no tier 2 model configured)`);
            continue;
        }

        logger?.debug('model-selector', `Attempting ${providerID}/${tier2ModelID}`);

        try {
            const model = await opencodeAI.getLanguageModel(providerID, tier2ModelID);
            logger?.info('model-selector', `✓ Successfully using tier 2 model from other provider`, {
                providerID,
                modelID: tier2ModelID
            });
            return {
                model,
                modelInfo: { providerID, modelID: tier2ModelID },
                tier: 'tier2-other-provider',
                reason: `Falling back to ${providerID}/${tier2ModelID}`
            };
        } catch (error: any) {
            logger?.warn('model-selector', `✗ Failed to use ${providerID}/${tier2ModelID}`, {
                error: error.message
            });
            continue;
        }
    }

    // Step 4: Ultimate fallback to big-pickle
    logger?.debug('model-selector', 'Step 4: Using ultimate fallback (big-pickle)');
    logger?.info('model-selector', '✓ Using big-pickle (free, no auth required)');
    return {
        model: getBigPickleModel(),
        modelInfo: { providerID: 'bigpickle', modelID: 'big-pickle' },
        tier: 'fallback',
        reason: 'Using free big-pickle model (no authenticated providers available)'
    };
}

/**
 * Helper to extract model info from OpenCode session state
 * This can be used by the plugin to get the current session's model
 */
export function extractModelFromSession(sessionState: any, logger?: Logger): ModelInfo | undefined {
    logger?.debug('model-selector', 'Extracting model from session state');

    // Try to get from ACP session state
    if (sessionState?.model?.providerID && sessionState?.model?.modelID) {
        logger?.info('model-selector', 'Found model in ACP session state', {
            providerID: sessionState.model.providerID,
            modelID: sessionState.model.modelID
        });
        return {
            providerID: sessionState.model.providerID,
            modelID: sessionState.model.modelID
        };
    }

    // Try to get from last message
    if (sessionState?.messages && Array.isArray(sessionState.messages)) {
        const lastMessage = sessionState.messages[sessionState.messages.length - 1];
        if (lastMessage?.model?.providerID && lastMessage?.model?.modelID) {
            logger?.info('model-selector', 'Found model in last message', {
                providerID: lastMessage.model.providerID,
                modelID: lastMessage.model.modelID
            });
            return {
                providerID: lastMessage.model.providerID,
                modelID: lastMessage.model.modelID
            };
        }
    }

    logger?.warn('model-selector', 'Could not extract model from session state');
    return undefined;
}
