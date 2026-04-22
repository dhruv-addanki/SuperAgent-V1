import { z } from "zod";

export const googleStartQuerySchema = z.object({
  phone: z.string().min(5)
});

export const googleCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1)
});

export const asanaStartQuerySchema = z.object({
  phone: z.string().min(5)
});

export const asanaCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1)
});

export const whatsappVerifyQuerySchema = z.object({
  "hub.mode": z.string(),
  "hub.verify_token": z.string(),
  "hub.challenge": z.string()
});
