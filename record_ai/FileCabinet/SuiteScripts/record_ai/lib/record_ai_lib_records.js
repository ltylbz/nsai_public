/**
 * @NApiVersion 2.1
 * Field IDs for Record AI job queue and shared provider/model registries.
 */
define([], () => {
  return {
    job: {
      type: "customrecord_record_ai_job",
      fields: {
        user: "custrecord_record_ai_job_user",
        provider: "custrecord_record_ai_job_provider",
        model: "custrecord_record_ai_job_model",
        question: "custrecord_record_ai_job_question",
        history: "custrecord_record_ai_job_history",
        status: "custrecord_record_ai_job_status",
        taskId: "custrecord_record_ai_job_task_id",
        error: "custrecord_record_ai_job_error",
        result: "custrecord_record_ai_job_result",
        recordType: "custrecord_record_ai_job_record_type",
        recordId: "custrecord_record_ai_job_record_id",
        params: "custrecord_record_ai_job_params",
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
