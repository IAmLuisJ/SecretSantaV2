export class MembershipChanged extends Error {
  constructor() {
    super("Your group or sign-in changed. Refresh this page and try again.");
  }
}
