import { z } from 'zod';

// "Segnala" form in the account menu: pick a category, describe the issue.
// Keep this list in sync with the CHECK constraint in database/add_reports.sql
// and the options in frontend/src/components/ReportModal.jsx.
export const REPORT_TYPES = ['bug', 'contenuto', 'account', 'suggerimento', 'altro'];

export const createReportSchema = z.object({
  type: z.enum(REPORT_TYPES),
  message: z.string().trim().min(5).max(1000),
});

// Admin list filter.
export const listReportsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  type: z.enum(REPORT_TYPES).optional(),
  status: z.enum(['new', 'done', 'rejected']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Admin status change.
export const updateReportSchema = z.object({
  status: z.enum(['new', 'done', 'rejected']),
});
