import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CONFIG } from "../_shared/config.ts";
import {
  downloadTelegramVoice,
  sendMessage,
  startTypingLoop,
} from "../_shared/telegram.ts";
import { transcribeAudio } from "../_shared/gemini.ts";
import {
  generateStructuredRouted,
  RoutedGenerationError,
  type ModelRouteAttempt,
} from "../_shared/model-router.ts";
import {
  ANALYSIS_SCHEMA,
  applyCurrentState,
  buildUserPrompt,
  chooseThinkingLevel,
  embedRecordsByIds,
  findHardSecret,
  HELP_TEXT,
  parseInput,
  persistOperations,
  renderCurrentState,
  normalizeTelegramReply,
  sha256Hex,
  SYSTEM_PROMPT,
  tryDeterministicResponse,
} from "../_shared/os.ts";
import type { Analysis } from "../_shared/os.ts";
import { fetchContext, routeSensitivityHint } from "../_shared/retrieval.ts";

declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void;
};

const supabase = createClient(CONFIG.supabaseUrl, CONFIG.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function logModelRun(args: {
  userId: string;
  conversationId: string;
  messageId?: string | null;
  task: string;
  provider?: string;
  model: string;
  status: "completed" | "failed";
  latencyMs?: number;
  inputChars?: number;
  outputChars?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
  totalTokens?: number | null;
  error?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await supabase.from("model_runs").insert({
      user_id: args.userId,
      conversation_id: args.conversationId,
      message_id: args.messageId ?? null,
      task: args.task,
      provider: args.provider ?? "google",
      model: args.model,
      status: args.status,
      latency_ms: args.latencyMs ?? null,
      input_chars: args.inputChars ?? null,
      output_chars: args.outputChars ?? null,
      input_tokens: args.inputTokens ?? null,
      output_tokens: args.outputTokens ?? null,
      thinking_tokens: args.thinkingTokens ?? null,
      total_tokens: args.totalTokens ?? null,
      error: args.error?.slice(0, 1500) ?? null,
      metadata: args.metadata ?? {},
    });
  } catch (error) {
    console.error("model_runs logging failed", error);
  }
}

async function logRouteAttempts(args: {
  userId: string;
  conversationId: string;
  messageId?: string | null;
  attempts: ModelRouteAttempt[];
  inputChars: number;
  mode: string;
  routeReason?: string;
  semanticRetrieval?: boolean;
  retrievedRecords?: number;
  retrievedChunks?: number;
}) {
  for (let i = 0; i < args.attempts.length; i++) {
    const attempt = args.attempts[i];
    await logModelRun({
      userId: args.userId,
      conversationId: args.conversationId,
      messageId: args.messageId,
      task: "coach_structured",
      provider: attempt.provider,
      model: attempt.model,
      status: attempt.status,
      latencyMs: attempt.latencyMs,
      inputChars: args.inputChars,
      outputChars: attempt.rawChars ?? undefined,
      inputTokens: attempt.usage?.inputTokens ?? null,
      outputTokens: attempt.usage?.outputTokens ?? null,
      thinkingTokens: attempt.usage?.thinkingTokens ?? null,
      totalTokens: attempt.usage?.totalTokens ?? null,
      error: attempt.error ?? undefined,
      metadata: {
        mode: args.mode,
        route_reason: args.routeReason ?? null,
        attempt_number: i + 1,
        requested_thinking_level: attempt.requestedThinkingLevel,
        effective_thinking_level: attempt.effectiveThinkingLevel,
        error_kind: attempt.errorKind,
        error_code: attempt.errorCode,
        quota_id: attempt.quotaId,
        quota_metric: attempt.quotaMetric,
        estimated_cost_usd: attempt.estimatedCostUsd,
        served_model: attempt.servedModel,
        semantic_retrieval: args.semanticRetrieval ?? null,
        retrieved_records: args.retrievedRecords ?? null,
        retrieved_chunks: args.retrievedChunks ?? null,
      },
    });
  }
}

async function markIngress(
  ingressId: string,
  status: "processing" | "completed" | "failed" | "blocked",
  error?: string,
) {
  const patch: Record<string, unknown> = { status };
  if (status === "processing") patch.processing_started_at = new Date().toISOString();
  if (["completed", "failed", "blocked"].includes(status)) {
    patch.processing_completed_at = new Date().toISOString();
  }
  if (error) patch.error = error.slice(0, 1800);
  const { error: dbError } = await supabase.from("ingress_events").update(patch).eq("id", ingressId);
  if (dbError) console.error("markIngress failed", dbError);
}

async function getOrCreateUserAndConversation(msg: any) {
  const telegramUserId = String(msg.from.id);

  const { data: user, error: userError } = await supabase
    .from("users")
    .upsert(
      {
        telegram_user_id: telegramUserId,
        telegram_username: msg.from.username ?? null,
        display_name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || null,
        locale: msg.from.language_code ?? null,
      },
      { onConflict: "telegram_user_id" },
    )
    .select("id,timezone,locale")
    .single();

  if (userError || !user) throw new Error(`User DB error: ${userError?.message ?? "no user"}`);

  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .upsert(
      {
        user_id: user.id,
        channel: "telegram",
        external_chat_id: String(msg.chat.id),
        coach_key: "default",
      },
      { onConflict: "user_id,channel,external_chat_id,coach_key" },
    )
    .select("id")
    .single();

  if (conversationError || !conversation) {
    throw new Error(`Conversation DB error: ${conversationError?.message ?? "no conversation"}`);
  }

  return { user, conversation };
}

async function insertPlaceholderUserMessage(args: {
  userId: string;
  conversationId: string;
  externalMessageId: string;
  inputType: "text" | "voice";
  contentHash: string;
  routing: Record<string, unknown>;
}) {
  const { data, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: args.conversationId,
      user_id: args.userId,
      role: "user",
      input_type: args.inputType,
      content: null,
      transcript: null,
      content_hash: args.contentHash,
      external_message_id: args.externalMessageId,
      sensitivity: "unclassified",
      store_raw: false,
      processing_status: "processing",
      routing: args.routing,
      analysis: {},
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(`Message insert failed: ${error?.message ?? "no row"}`);
  return data.id as string;
}

async function processUpdate(args: {
  ingressId: string;
  msg: any;
  user: any;
  conversation: any;
}) {
  const { ingressId, msg, user, conversation } = args;
  const chatId = Number(msg.chat.id);
  const externalMessageId = String(msg.message_id);
  const inputType: "text" | "voice" = msg.voice ? "voice" : "text";
  let userMessageId: string | null = null;
  let selectedModel = CONFIG.defaultModel;
  let selectedProvider = CONFIG.defaultProvider;
  let routePromptChars = 0;
  let routeMode = "normal";
  let routeSemanticRetrieval: boolean | undefined;
  let routeRetrievedRecords: number | undefined;
  let routeRetrievedChunks: number | undefined;
  const stopTyping = startTypingLoop(chatId);

  try {
    await markIngress(ingressId, "processing");

    let inputText = "";
    let transcriptionLatencyMs: number | null = null;

    if (msg.voice) {
      const audio = await downloadTelegramVoice(msg.voice);
      const transcribed = await transcribeAudio(audio.bytes, audio.mimeType);
      inputText = transcribed.text.trim();
      transcriptionLatencyMs = transcribed.latencyMs;

      await logModelRun({
        userId: user.id,
        conversationId: conversation.id,
        task: "transcription",
        provider: "google",
        model: CONFIG.transcriptionModel,
        status: "completed",
        latencyMs: transcribed.latencyMs,
        inputChars: audio.bytes.byteLength,
        outputChars: inputText.length,
        inputTokens: transcribed.usage.inputTokens,
        outputTokens: transcribed.usage.outputTokens,
        thinkingTokens: transcribed.usage.thinkingTokens,
        totalTokens: transcribed.usage.totalTokens,
        metadata: {
          mime_type: audio.mimeType,
          telegram_file_unique_id: audio.fileUniqueId,
          duration_seconds: audio.durationSeconds,
          transcription_mode: "SMART",
        },
      });
    } else {
      inputText = String(msg.text ?? "").trim();
    }

    if (!inputText) {
      await sendMessage(chatId, "Στείλε μου κείμενο ή Telegram voice note.");
      await markIngress(ingressId, "completed");
      return;
    }

    const parsed = parseInput(inputText);

    if (parsed.command === "help") {
      await sendMessage(chatId, HELP_TEXT);
      await markIngress(ingressId, "completed");
      return;
    }

    if (parsed.command === "state") {
      const { data: state } = await supabase
        .from("current_state")
        .select("*")
        .eq("user_id", user.id)
        .eq("coach_key", "default")
        .maybeSingle();
      await sendMessage(chatId, renderCurrentState(state));
      await markIngress(ingressId, "completed");
      return;
    }

    const cleanText = parsed.text.trim();
    if (!cleanText) {
      await sendMessage(chatId, "Το command χρειάζεται κείμενο μετά από αυτό.");
      await markIngress(ingressId, "completed");
      return;
    }

    const deterministic = tryDeterministicResponse(cleanText, user.timezone || "Europe/Athens");
    if (deterministic) {
      await sendMessage(chatId, deterministic);
      await markIngress(ingressId, "completed");
      return;
    }

    const hardSecret = findHardSecret(cleanText);
    const contentHash = await sha256Hex(cleanText);
    const thinkingLevel = chooseThinkingLevel(cleanText, parsed.mode);

    userMessageId = await insertPlaceholderUserMessage({
      userId: user.id,
      conversationId: conversation.id,
      externalMessageId,
      inputType,
      contentHash,
      routing: {
        mode: parsed.mode,
        thinking_level: thinkingLevel,
        model: null,
        route_status: "pending",
        transcription_latency_ms: transcriptionLatencyMs,
      },
    });

    // Text secrets are blocked before the conversational/reasoning model ever sees them.
    // A voice note must first be transcribed by the configured cloud STT provider, so never speak secrets into voice.
    if (hardSecret) {
      await supabase.from("messages").update({
        sensitivity: "restricted",
        store_raw: false,
        processing_status: "blocked",
        analysis: { blocked_reason: hardSecret },
      }).eq("id", userMessageId);

      await sendMessage(
        chatId,
        "🔒 Εντόπισα πιθανό secret/token/password. Δεν το αποθήκευσα και δεν το έστειλα στο conversational AI. Αφαίρεσε/κρύψε την πραγματική τιμή και ξαναστείλε το υπόλοιπο.",
      );
      await markIngress(ingressId, "blocked");
      return;
    }

    const context = await fetchContext({
      supabase,
      userId: user.id,
      conversationId: conversation.id,
      text: cleanText,
      mode: parsed.mode,
      thinkingLevel,
      useSemantic: thinkingLevel !== "MINIMAL",
    });

    const userPrompt = buildUserPrompt({
      inputText: cleanText,
      inputMode: parsed.mode,
      currentState: context.currentState,
      recentMessages: context.recentMessages,
      relevantRecords: context.relevantRecords,
      relevantChunks: context.relevantChunks,
      nowIso: new Date().toISOString(),
      timezone: user.timezone || "Europe/Athens",
      domainHints: context.domainHints,
      retrievalQuery: context.retrievalQuery,
      currentStateIncluded: context.currentStateIncluded,
      retrievalDepth: context.retrievalDepth,
      broadContext: context.broadContext,
      hybridRecordCount: context.hybridRecordCount,
      profileRecordCount: context.profileRecordCount,
      resolvedEntities: context.resolvedEntities,
      historicalEvidenceIncluded: context.historicalEvidenceIncluded,
      requiredDomains: context.requiredDomains,
      strictDomain: context.strictDomain,
    });

    routePromptChars = userPrompt.length;
    routeMode = parsed.mode;
    routeSemanticRetrieval = context.semanticRetrieval;
    routeRetrievedRecords = context.relevantRecords.length;
    routeRetrievedChunks = context.relevantChunks.length;

    const routeSensitivity = routeSensitivityHint(cleanText, context.domainHints, {
      recentMessages: context.recentMessages,
      relevantRecords: context.relevantRecords,
      relevantChunks: context.relevantChunks,
    });
    const generated = await generateStructuredRouted<Analysis>({
      supabase,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      schema: ANALYSIS_SCHEMA,
      thinkingLevel,
      mode: parsed.mode,
      sensitivity: routeSensitivity,
    });
    selectedModel = generated.model;
    selectedProvider = generated.provider;

    await logRouteAttempts({
      userId: user.id,
      conversationId: conversation.id,
      messageId: userMessageId,
      attempts: generated.attempts,
      inputChars: userPrompt.length,
      mode: parsed.mode,
      routeReason: generated.routeReason,
      semanticRetrieval: context.semanticRetrieval,
      retrievedRecords: context.relevantRecords.length,
      retrievedChunks: context.relevantChunks.length,
    });

    const analysis = generated.value;
    const sensitivity = analysis.classification.sensitivity;
    const forceNoStore = parsed.mode === "nostore";
    const storeRaw = Boolean(analysis.classification.store_raw)
      && !forceNoStore
      && sensitivity !== "work_confidential"
      && sensitivity !== "restricted";

    await supabase.from("messages").update({
      content: inputType === "text" && storeRaw ? cleanText : null,
      transcript: inputType === "voice" && storeRaw ? cleanText : null,
      sensitivity,
      store_raw: storeRaw,
      processing_status: "completed",
      routing: {
        mode: parsed.mode,
        requested_thinking_level: thinkingLevel,
        effective_thinking_level: generated.effectiveThinkingLevel,
        provider: generated.provider,
        model: selectedModel,
        served_model: generated.servedModel,
        fallback_used: generated.fallbackUsed,
        attempted_models: generated.attempts.map((attempt) => attempt.model),
        skipped_models: generated.skippedModels,
        route_reason: generated.routeReason,
        route_candidates: generated.candidates,
        semantic_retrieval: context.semanticRetrieval,
        retrieval_query: context.retrievalQuery,
        domain_hints: context.domainHints,
        current_state_included: context.currentStateIncluded,
        retrieved_records: context.relevantRecords.length,
        retrieved_chunks: context.relevantChunks.length,
        retrieval_depth: context.retrievalDepth,
        broad_context: context.broadContext,
        hybrid_record_count: context.hybridRecordCount,
        profile_record_count: context.profileRecordCount,
        resolved_entities: context.resolvedEntities.map((entity: any) => ({ id: entity.id, name: entity.canonical_name, type: entity.entity_type, match: entity.match })),
        required_domains: context.requiredDomains,
        strict_domain: context.strictDomain,
        historical_evidence_included: context.historicalEvidenceIncluded,
        route_sensitivity: routeSensitivity,
        transcription_latency_ms: transcriptionLatencyMs,
      },
      analysis: {
        intent: analysis.classification.intent,
        domains: analysis.classification.domains,
        fact_state: analysis.classification.fact_state,
        operation_count: analysis.operations?.length ?? 0,
        current_state_apply: analysis.current_state?.apply ?? false,
      },
      provider: selectedProvider,
      model: selectedModel,
      latency_ms: generated.latencyMs,
    }).eq("id", userMessageId);

    const reply = normalizeTelegramReply(analysis.response?.text?.trim() || "Καταγράφηκε.");

    const { error: assistantError } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversation.id,
        user_id: user.id,
        role: "assistant",
        input_type: "text",
        content: storeRaw ? reply : null,
        content_hash: await sha256Hex(reply),
        sensitivity,
        store_raw: storeRaw,
        processing_status: "completed",
        routing: {
          mode: parsed.mode,
          requested_thinking_level: thinkingLevel,
          effective_thinking_level: generated.effectiveThinkingLevel,
          provider: selectedProvider,
          model: selectedModel,
          served_model: generated.servedModel,
          fallback_used: generated.fallbackUsed,
          route_reason: generated.routeReason,
        },
        analysis: {},
        provider: selectedProvider,
        model: selectedModel,
        latency_ms: generated.latencyMs,
      });
    if (assistantError) console.error("assistant message insert error", assistantError);

    // Optimize perceived latency: the user gets the answer before DB enrichment/embedding finishes.
    await sendMessage(chatId, reply);

    try {
      const recordIdsToEmbed = await persistOperations({
        supabase,
        userId: user.id,
        messageId: userMessageId,
        analysis,
        authorityLevel: 100,
      });

      const currentStateResult = await applyCurrentState({
        supabase,
        userId: user.id,
        messageId: userMessageId,
        inputText: cleanText,
        classificationIntent: analysis.classification.intent,
        classificationFactState: analysis.classification.fact_state,
        state: analysis.current_state,
      });
      if (analysis.current_state?.apply && !currentStateResult.applied) {
        console.log("current_state update rejected by guard", currentStateResult.reason);
      }

      // Records are immediately FTS-searchable; vector enrichment is best-effort after the reply.
      await embedRecordsByIds({
        supabase,
        userId: user.id,
        recordIds: recordIdsToEmbed,
      });

      await markIngress(ingressId, "completed");
    } catch (enrichmentError) {
      const enrichmentMessage = enrichmentError instanceof Error
        ? enrichmentError.message
        : String(enrichmentError);
      console.error("post-reply enrichment failed", enrichmentMessage, enrichmentError);
      // The conversational response succeeded, so do not turn this into a fake model failure.
      // Keep ingress completed but preserve the enrichment error for diagnostics.
      await markIngress(ingressId, "completed", `post_reply_enrichment: ${enrichmentMessage}`);
      try {
        await sendMessage(
          chatId,
          "ℹ️ Η απάντηση δόθηκε κανονικά, αλλά η ενημέρωση της μνήμης δεν ολοκληρώθηκε πλήρως. Δεν χρειάζεται να ξαναστείλεις το μήνυμα τώρα.",
        );
      } catch (telegramError) {
        console.error("Could not send enrichment warning", telegramError);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("processUpdate failed", message, error);

    if (userMessageId) {
      await supabase.from("messages").update({
        processing_status: "failed",
        store_raw: false,
        content: null,
        transcript: null,
        analysis: { error: "processing_failed" },
      }).eq("id", userMessageId);
    }

    if (error instanceof RoutedGenerationError) {
      const finalAttempt = error.attempts.at(-1);
      if (finalAttempt?.model) selectedModel = finalAttempt.model;
      if (finalAttempt?.provider) selectedProvider = finalAttempt.provider;
      await logRouteAttempts({
        userId: user.id,
        conversationId: conversation.id,
        messageId: userMessageId,
        attempts: error.attempts,
        inputChars: routePromptChars,
        mode: routeMode,
        semanticRetrieval: routeSemanticRetrieval,
        retrievedRecords: routeRetrievedRecords,
        retrievedChunks: routeRetrievedChunks,
      });
    } else {
      await logModelRun({
        userId: user.id,
        conversationId: conversation.id,
        messageId: userMessageId,
        task: "processing",
        provider: selectedProvider,
        model: selectedModel,
        status: "failed",
        error: message,
      });
    }

    await markIngress(ingressId, "failed", message);

    try {
      let friendly: string;
      if (message.includes("Voice note is too long")) {
        friendly = `🎙️ Το voice note είναι πολύ μεγάλο για το τωρινό realtime path. Κράτησέ το έως ${Math.floor(CONFIG.maxVoiceSeconds / 60)} λεπτά ή πέρασέ το αργότερα από το historical import pipeline.`;
      } else if (error instanceof RoutedGenerationError && error.errorKind === "all_models_quota_blocked") {
        friendly = "⏳ Τα διαθέσιμα chat models έχουν προσωρινά εξαντλήσει το quota τους. Το Telegram και η βάση είναι ΟΚ· το router θα ξαναδοκιμάσει αυτόματα όταν ανοίξει διαθέσιμο model capacity.";
      } else if (error instanceof RoutedGenerationError && error.errorKind === "all_routes_blocked") {
        friendly = "🛡️ Δεν υπάρχει αυτή τη στιγμή επιτρεπτή AI διαδρομή για αυτό το αίτημα (quota, privacy policy ή budget guard). Η βάση και το Telegram είναι ΟΚ και δεν έγινε unsafe fallback.";
      } else if (error instanceof RoutedGenerationError) {
        friendly = "⚠️ Οι διαθέσιμες AI διαδρομές απέτυχαν προσωρινά. Το μήνυμα σημειώθηκε ως failed και το router θα χρησιμοποιήσει ξανά το καλύτερο διαθέσιμο model στο επόμενο αίτημα.";
      } else {
        friendly = "⚠️ Παρουσιάστηκε προσωρινό τεχνικό πρόβλημα στην επεξεργασία. Το μήνυμα δεν θεωρήθηκε επιτυχώς επεξεργασμένο· δοκίμασε ξανά λίγο αργότερα.";
      }
      await sendMessage(chatId, friendly);
    } catch (telegramError) {
      console.error("Could not send failure message", telegramError);
    }
  } finally {
    stopTyping();
  }
}

Deno.serve(async (req) => {
  if (req.method === "GET") {
    return Response.json({ ok: true, service: "personal-os-telegram", version: CONFIG.version });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const incomingSecret = req.headers.get("x-telegram-bot-api-secret-token");
  if (!incomingSecret || incomingSecret !== CONFIG.telegramWebhookSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return Response.json({ ok: true });
  }

  const msg = update?.message;
  if (!msg?.from || !msg?.chat) return Response.json({ ok: true });

  // Personal bot: silently ignore every Telegram account except the owner.
  if (String(msg.from.id) !== CONFIG.telegramAllowedUserId) {
    return Response.json({ ok: true });
  }

  if (!msg.text && !msg.voice) {
    EdgeRuntime.waitUntil(
      sendMessage(Number(msg.chat.id), "Προς το παρόν το Personal OS δέχεται text και Telegram voice notes."),
    );
    return Response.json({ ok: true });
  }

  try {
    const { user, conversation } = await getOrCreateUserAndConversation(msg);
    const externalEventId = String(update.update_id ?? `${msg.chat.id}:${msg.message_id}`);

    const { data: ingress, error: ingressError } = await supabase
      .from("ingress_events")
      .insert({
        provider: "telegram",
        external_event_id: externalEventId,
        external_message_id: String(msg.message_id),
        user_id: user.id,
        conversation_id: conversation.id,
        input_type: msg.voice ? "voice" : "text",
        status: "queued",
      })
      .select("id")
      .single();

    if (ingressError) {
      // PostgreSQL unique violation means Telegram retried an update we already accepted.
      if (ingressError.code === "23505") {
        return Response.json({ ok: true, duplicate: true });
      }
      throw new Error(`Ingress insert failed: ${ingressError.message}`);
    }

    EdgeRuntime.waitUntil(
      processUpdate({
        ingressId: ingress.id,
        msg,
        user,
        conversation,
      }),
    );

    // Acknowledge Telegram immediately. AI work continues in waitUntil(), preventing retry storms.
    return Response.json({ ok: true, accepted: true });
  } catch (error) {
    console.error("Webhook acceptance failed", error);
    // Return 200 so permanent configuration errors do not create Telegram retry storms.
    return Response.json({ ok: false, accepted: false });
  }
});
