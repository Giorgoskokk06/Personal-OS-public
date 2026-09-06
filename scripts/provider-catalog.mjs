#!/usr/bin/env node
export const NVIDIA_MODELS = [
  { model: "nvidia/nemotron-3.5-lightning-30b-a3b", roles: "fast,capture,normal,deep", preferred: "fast,capture", preflightTokens: 512, thinking: "nemotron" },
  { model: "deepseek-ai/deepseek-v4-flash-0731", roles: "fast,capture,normal,deep", preferred: "normal", preflightTokens: 768, thinking: "deepseek" },
  { model: "deepseek-ai/deepseek-v4-pro-0813", roles: "normal,deep", preferred: "deep", preflightTokens: 768, thinking: "deepseek" },
  { model: "nvidia/nemotron-3-super-120b-a12b", roles: "normal,deep", preferred: "deep", preflightTokens: 768, thinking: "nemotron" },
  { model: "nvidia/nemotron-3-ultra-550b-a55b", roles: "deep", preferred: "deep", preflightTokens: 1024, thinking: "nemotron" },
  { model: "moonshotai/kimi-k3", roles: "normal,deep", preferred: "deep", preflightTokens: 2048, thinking: "kimi" },
];

export function nvidiaModelProfile(model) {
  return NVIDIA_MODELS.find((entry) => entry.model === model) || null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--ids")) {
    for (const entry of NVIDIA_MODELS) console.log(entry.model);
  } else {
    console.table(NVIDIA_MODELS);
  }
}
