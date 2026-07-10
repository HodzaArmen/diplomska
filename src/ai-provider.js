/**
 * ai-provider.js — več ponudnikov za AI razlago (Groq brezplačno, Gemini, OpenAI)
 *
 * Prioriteta (če AI_PROVIDER ni nastavljen):
 *   groq → gemini → openai
 */

import axios from 'axios';

const PROVIDERS = {
    groq: {
        id: 'groq',
        label: 'Groq',
        keyEnv: 'GROQ_API_KEY',
        modelEnv: 'GROQ_MODEL',
        defaultModel: 'llama-3.3-70b-versatile',
        free: true,
        signupUrl: 'https://console.groq.com/keys'
    },
    gemini: {
        id: 'gemini',
        label: 'Google Gemini (brezplačno)',
        keyEnv: 'GEMINI_API_KEY',
        modelEnv: 'GEMINI_MODEL',
        defaultModel: 'gemini-2.0-flash',
        free: true,
        signupUrl: 'https://aistudio.google.com/apikey'
    },
    openai: {
        id: 'openai',
        label: 'OpenAI',
        keyEnv: 'OPENAI_API_KEY',
        modelEnv: 'OPENAI_MODEL',
        defaultModel: 'gpt-4o-mini',
        free: false,
        signupUrl: 'https://platform.openai.com/api-keys'
    }
};

const ORDER = ['groq', 'gemini', 'openai'];

export function getAiProviderConfig(providerId) {
    return PROVIDERS[providerId] || null;
}

/** Kateri ponudnik je aktiven (ključ nastavljen) */
export function resolveActiveAiProvider() {
    const forced = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
    if (forced && PROVIDERS[forced] && process.env[PROVIDERS[forced].keyEnv]) {
        return { ...PROVIDERS[forced], apiKey: process.env[PROVIDERS[forced].keyEnv] };
    }
    for (const id of ORDER) {
        const cfg = PROVIDERS[id];
        const key = process.env[cfg.keyEnv];
        if (key) {
            return { ...cfg, apiKey: key };
        }
    }
    return null;
}

export function getAiStatus() {
    const active = resolveActiveAiProvider();
    const available = ORDER.map((id) => {
        const cfg = PROVIDERS[id];
        return {
            id: cfg.id,
            label: cfg.label,
            free: cfg.free,
            configured: Boolean(process.env[cfg.keyEnv]),
            signupUrl: cfg.signupUrl,
            model: process.env[cfg.modelEnv] || cfg.defaultModel
        };
    });
    return {
        configured: Boolean(active),
        activeProvider: active?.id || null,
        activeLabel: active?.label || null,
        activeModel: active
            ? (process.env[active.modelEnv] || active.defaultModel)
            : null,
        providers: available,
        hint: active
            ? null
            : 'Dodajte GROQ_API_KEY v src/.env (brezplačno na console.groq.com) in restartajte app.'
    };
}

async function chatOpenAiCompatible({ baseUrl, apiKey, model, systemPrompt, userPrompt }) {
    const { data } = await axios.post(
        baseUrl,
        {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.3,
            max_tokens: 700
        },
        {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 45000
        }
    );
    return data?.choices?.[0]?.message?.content?.trim() || null;
}

async function chatGemini({ apiKey, model, systemPrompt, userPrompt }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const { data } = await axios.post(
        url,
        {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: {
                temperature: 0.3,
                maxOutputTokens: 700
            }
        },
        {
            params: { key: apiKey },
            headers: { 'Content-Type': 'application/json' },
            timeout: 45000
        }
    );
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p.text).filter(Boolean).join('\n').trim() || null;
}

/**
 * @returns {{ ok: boolean, text?: string, provider?: string, model?: string, error?: string }}
 */
export async function generateAiText({ systemPrompt, userPrompt }) {
    const provider = resolveActiveAiProvider();
    if (!provider) {
        return {
            ok: false,
            error: 'Ni AI ključa. Nastavite GROQ_API_KEY (brezplačno) v src/.env.'
        };
    }

    const model = process.env[provider.modelEnv] || provider.defaultModel;

    try {
        let text = null;
        if (provider.id === 'groq') {
            text = await chatOpenAiCompatible({
                baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
                apiKey: provider.apiKey,
                model,
                systemPrompt,
                userPrompt
            });
        } else if (provider.id === 'openai') {
            text = await chatOpenAiCompatible({
                baseUrl: 'https://api.openai.com/v1/chat/completions',
                apiKey: provider.apiKey,
                model,
                systemPrompt,
                userPrompt
            });
        } else if (provider.id === 'gemini') {
            text = await chatGemini({
                apiKey: provider.apiKey,
                model,
                systemPrompt,
                userPrompt
            });
        }

        if (!text) {
            return { ok: false, error: `${provider.label} ni vrnil besedila`, provider: provider.id };
        }

        return {
            ok: true,
            text,
            provider: provider.id,
            providerLabel: provider.label,
            model
        };
    } catch (error) {
        const msg = error.response?.data?.error?.message
            || error.response?.data?.error?.status
            || error.response?.data?.message
            || error.message;
        return {
            ok: false,
            error: msg,
            provider: provider.id,
            providerLabel: provider.label
        };
    }
}
