export type Env = {
  DB: D1Database;
  PHOTOS: R2Bucket;
  BETTER_AUTH_SECRET: string;
  APP_ORIGIN?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  LOCAL_MAIL?: string;
};
