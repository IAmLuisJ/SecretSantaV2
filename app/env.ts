export type Env = {
  DB: D1Database;
  PHOTOS: R2Bucket;
  BETTER_AUTH_SECRET: string;
  APP_ORIGIN?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  EMAIL_SIGN_IN_ENABLED?: string;
  LOCAL_MAIL?: string;
};
