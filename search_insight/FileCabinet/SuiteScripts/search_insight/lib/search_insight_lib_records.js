/**
 * @NApiVersion 2.1
 * Field IDs for Search Insight job queue and shared provider/model registries.
 */
define([], () => {
  return {
    job: {
      type: "customrecord_search_insight_job",
      fields: {
        user: "custrecord_search_insight_job_user",
        question: "custrecord_search_insight_job_question",
        history: "custrecord_search_insight_job_history",
        status: "custrecord_search_insight_job_status",
        taskId: "custrecord_search_insight_job_task_id",
        error: "custrecord_search_insight_job_error",
        result: "custrecord_search_insight_job_result",
        searchId: "custrecord_search_insight_job_search_id",
        searchTitle: "custrecord_search_insight_job_title",
        provider: "custrecord_search_insight_job_provider",
        model: "custrecord_search_insight_job_model",
      },
    },
    provider: {
      type: "customrecord_ai_provider",
      fields: {
        name: "custrecord_nai_secret_provider",
        apiKey: "custrecord_nai_secret_key",
        url: "custrecord_nai_secret_url",
      },
    },
    model: {
      type: "customrecord_ai_models",
      fields: {
        parent: "custrecord_nai_provider_parent",
        modelId: "custrecord_nai_model_id",
        usage: "custrecord_model_usage",
      },
    },
  };
});
