function intEnv(key, fallback) {
  const v = parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const certConfig = {
  // Upload / extraction guardrails (protect memory & disk from abuse).
  maxZipBytes: intEnv('CERT_MAX_ZIP_BYTES', 500 * 1024 * 1024),        // 500MB compressed (streamed, not loaded fully into memory)
  // A single multi-page PDF is loaded fully into memory (pdf-lib + pdfjs-dist
  // both need the whole buffer), so it gets a materially smaller cap than the
  // streamed ZIP path.
  //
  // Lowered from 200MB: the splitter buffers the file, copies it again as a
  // Uint8Array, and then pdf-lib/pdfjs build object graphs typically 3-10x the
  // file size — so 200MB meant 2-4GB RSS for ONE request, and the parse is
  // synchronous, so it blocks the event loop for every other tenant while it
  // runs. 50MB matches the per-certificate cap below and keeps the worst case
  // survivable on a normal container. Raising this is only safe once splitting
  // moves to a worker thread with a timeout and an in-flight limit.
  maxSinglePdfBytes: intEnv('CERT_MAX_SINGLE_PDF_BYTES', 50 * 1024 * 1024), // 50MB
  maxSheetBytes: intEnv('CERT_MAX_SHEET_BYTES', 10 * 1024 * 1024),     // 10MB sheet
  // Real-world certificate PDFs (Canva/Adobe exports with embedded fonts and
  // print-quality images) commonly land in the 10-40MB range — 25MB was too
  // tight and silently rejected legitimate certificates.
  maxPdfBytes: intEnv('CERT_MAX_PDF_BYTES', 50 * 1024 * 1024),         // 50MB per certificate (per split page too)
  maxTotalExtractedBytes: intEnv('CERT_MAX_TOTAL_BYTES', 3 * 1024 * 1024 * 1024), // 3GB uncompressed
  maxPdfCount: intEnv('CERT_MAX_PDF_COUNT', 20000),                    // entries per zip, or pages per multi-page PDF
  maxRows: intEnv('CERT_MAX_ROWS', 20000),                             // rows per sheet

  // Background delivery.
  sendConcurrency: intEnv('CERT_SEND_CONCURRENCY', 5),                 // parallel workers per job

  // Abandoned "ready" jobs (never sent) are swept + cleaned after this window.
  readyTtlHours: intEnv('CERT_READY_TTL_HOURS', 24),
  // Completed/canceled jobs keep their DB rows this long (files already deleted).
  completedRetentionHours: intEnv('CERT_COMPLETED_RETENTION_HOURS', 72),
  // How often the sweeper runs.
  sweepIntervalMs: intEnv('CERT_SWEEP_INTERVAL_MS', 30 * 60 * 1000),
};
