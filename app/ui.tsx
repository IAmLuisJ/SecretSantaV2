import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Form, Link, useLocation, useNavigation } from "react-router";
import { ChristmasTree, HolidayStar, WrappedGift } from "./holiday-art";
import type { Address, DashboardData, GiftItem, Invite, User, Values } from "./types";
import "./styles.css";

const MembershipContext = createContext<string | null>(null);

type EntryProps = {
  user: User | null;
  invite: Invite | null;
  step: "email" | "code" | "group";
  error?: string;
  values: Values;
  defaultYear: number;
};

type DashboardProps = {
  data: DashboardData;
  message?: string;
  error?: string;
  values: Values;
};

type IconName = "arrow" | "gift" | "share" | "copy" | "facebook" | "pin" | "check" | "users";

function Icon({ name }: { name: IconName }) {
  const shapes: Record<IconName, ReactNode> = {
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
    gift: <><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M5 12v8h14v-8M12 8v12M12 8H8.5A2.5 2.5 0 1 1 11 5.5L12 8Zm0 0h3.5A2.5 2.5 0 1 0 13 5.5L12 8Z" /></>,
    share: <><path d="M12 15V3m-4 4 4-4 4 4M5 12v8h14v-8" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 4H6a2 2 0 0 0-2 2v10" /></>,
    facebook: <path d="M14 21v-8h3l.5-3H14V8.5c0-.9.3-1.5 1.7-1.5H18V4.2A17 17 0 0 0 15.2 4C12.3 4 11 5.6 11 8.1V10H8v3h3v8" />,
    pin: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    users: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2m2-15a3 3 0 0 1 0 6m1 3a5 5 0 0 1 3 4v2" /></>,
  };
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {shapes[name]}
    </svg>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="site-header">
        <div className="site-width">
          <Link className="wordmark" to="/">
            <HolidayStar className="brand-star" />
            Secret Santa
          </Link>
        </div>
      </header>
      <main id="main" className="site-width">{children}</main>
      <footer className="site-width site-footer">
        <HolidayStar className="footer-star" /> Secret Santa
      </footer>
    </>
  );
}

function Feedback({ error, message }: { error?: string; message?: string }) {
  return (
    <>
      {error && <p className="feedback feedback-error" role="alert">{error}</p>}
      {message && <p className="feedback feedback-success" role="status">{message}</p>}
    </>
  );
}

function ActionForm({ intent, action = "/exchange", children, className, upload = false, resetOn }: {
  intent: string;
  action?: string;
  children: ReactNode;
  className?: string;
  upload?: boolean;
  resetOn?: Values;
}) {
  const form = useRef<HTMLFormElement>(null);
  const actingMembershipId = useContext(MembershipContext);
  const { formData, state } = useNavigation();
  const pending = state !== "idle" && formData?.get("intent") === intent;
  useEffect(() => {
    if (resetOn) form.current?.reset();
  }, [resetOn]);
  return (
    <Form ref={form} method="post" action={action} className={className} encType={upload ? "multipart/form-data" : undefined} aria-busy={pending || undefined}>
      <input type="hidden" name="intent" value={intent} />
      {actingMembershipId && <input type="hidden" name="actingMembershipId" value={actingMembershipId} />}
      {children}
    </Form>
  );
}

function Submit({ intent, children, appearance = "", disabled = false }: {
  intent: string;
  children: ReactNode;
  appearance?: string;
  disabled?: boolean;
}) {
  const { formData, state } = useNavigation();
  const pending = state !== "idle" && formData?.get("intent") === intent;
  return (
    <button type="submit" className={`button ${appearance}`} disabled={disabled || pending}>
      {children}
    </button>
  );
}

function SignOut({ action }: { action?: string }) {
  return (
    <ActionForm intent="sign-out" action={action}>
      <Submit intent="sign-out" appearance="button-quiet">Sign out</Submit>
    </ActionForm>
  );
}

function ManualJoin({ code }: { code?: string }) {
  return (
    <details className="join-by-code" open={Boolean(code) || undefined}>
      <summary>Have a group code?</summary>
      <Form action="/join" method="get" className="form-stack">
        <label>Group code
          <input name="code" defaultValue={code} maxLength={40} required spellCheck={false} autoCapitalize="characters" />
        </label>
        <button type="submit" className="button button-secondary">Find group</button>
      </Form>
    </details>
  );
}

function EntryHero({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="entry-hero">
      <div className="entry-hero-copy">
        <h1>{title}</h1>
        {children && <p>{children}</p>}
      </div>
      <ChristmasTree />
    </div>
  );
}

export function Entry({ user, invite, step, error, values, defaultYear }: EntryProps) {
  const location = useLocation();
  const action = location.pathname + location.search;
  const manualCode = location.pathname === "/join" && !invite
    ? new URLSearchParams(location.search).get("code") ?? undefined
    : undefined;

  return (
    <div className="entry">
      <EntryHero title={invite ? "You’re invited." : "Meet under the tree."}>
        {invite ? "Join your group for a Christmas gift exchange." : "Make someone’s Christmas."}
      </EntryHero>
      <section className="entry-paper" aria-labelledby="entry-heading">
        {invite && (
          <div className="invite-preview">
            <span className="small-icon"><Icon name="gift" /></span>
            <div>
              <p className="section-note">Your invitation to</p>
              <p className="invite-name">{invite.name}</p>
              {invite.description && <p className="invite-description">{invite.description}</p>}
            </div>
          </div>
        )}
        <Feedback error={error} />
        {step === "email" && (
          <>
            <h2 id="entry-heading">{invite ? "Sign in to join" : "Sign in to Secret Santa"}</h2>
            <ActionForm intent="send-code" action={action} className="form-stack">
              <label>Email address
                <input type="email" name="email" autoComplete="email" defaultValue={values.email} maxLength={254} required />
              </label>
              <Submit intent="send-code">Send sign-in code</Submit>
            </ActionForm>
            <p className="entry-hint">We’ll send a six-digit code to your email.</p>
            {!invite && <ManualJoin code={manualCode} />}
          </>
        )}
        {step === "code" && (
          <>
            <h2 id="entry-heading">Check your inbox</h2>
            <p>Enter the six-digit code sent to <strong>{values.email}</strong>.</p>
            <ActionForm intent="verify-code" action={action} className="form-stack">
              <input type="hidden" name="email" value={values.email ?? ""} />
              <label>Sign-in code
                <input className="otp" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
              </label>
              <Submit intent="verify-code">Verify code <Icon name="arrow" /></Submit>
            </ActionForm>
            <div className="button-row entry-code-actions">
              <ActionForm intent="send-code" action={action}>
                <input type="hidden" name="email" value={values.email ?? ""} />
                <Submit intent="send-code" appearance="button-quiet">Send a new code</Submit>
              </ActionForm>
              <a className="button button-quiet" href={action}>Use a different email</a>
            </div>
          </>
        )}
        {step === "group" && (
          <>
            <h2 id="entry-heading">{invite ? "Join the exchange" : "Create an exchange"}</h2>
            <p>{invite ? "Enter the name your group will see." : "Set up your group, then send invitations."}</p>
            <ActionForm intent={invite ? "join-group" : "create-group"} action={action} className="form-stack">
              {invite ? <input type="hidden" name="code" value={invite.code} /> : (
                <>
                  <label>Group name
                    <input name="name" defaultValue={values.name} maxLength={80} required />
                  </label>
                  <label>Description <span className="optional">(optional)</span>
                    <textarea name="description" rows={2} defaultValue={values.description} maxLength={500} />
                  </label>
                  <label>First exchange year
                    <input name="year" type="number" min={1000} max={9999} step="1" inputMode="numeric" defaultValue={values.year || defaultYear} required />
                  </label>
                </>
              )}
              <label>Your display name
                <input name="displayName" autoComplete="nickname" defaultValue={values.displayName} maxLength={80} required />
              </label>
              <Submit intent={invite ? "join-group" : "create-group"}>
                {invite ? "Join group" : "Create group"} <Icon name="arrow" />
              </Submit>
            </ActionForm>
            {!invite && <ManualJoin code={manualCode} />}
            {user && (
              <div className="signed-in-row">
                <span>{user.email}</span>
                <SignOut action={action} />
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

export function ExpiredInvite() {
  return (
    <div className="entry">
      <EntryHero title="This invite has expired." />
      <section className="entry-paper">
        <h2>Get a fresh invite</h2>
        <p>Ask your organizer for a new Secret Santa invitation.</p>
        <Link className="button" to="/">Go to Secret Santa <Icon name="arrow" /></Link>
      </section>
    </div>
  );
}

function fieldsFor(values: Values | undefined, intent: string) {
  return values?.intent === intent ? values : undefined;
}

function WishList({ items, mode, empty }: {
  items: GiftItem[];
  mode: "adult" | "child" | "recipient";
  empty: string;
}) {
  if (items.length === 0) return <p className="empty-line">{empty}</p>;

  return (
    <ul className="wish-list">
      {items.map(item => (
        <li key={item.id} className="wish">
          {item.photoUrl && <img className="wish-photo" src={item.photoUrl} alt={item.name} loading="lazy" />}
          <div className="wish-content">
            <div className="wish-title">
              <p>{item.name}</p>
              {mode === "child" && item.purchased && <span className="tag"><Icon name="check" /> Purchased</span>}
            </div>
            {item.description && <p className="multiline">{item.description}</p>}
            {item.url && <a className="product-link" href={item.url} target="_blank" rel="noreferrer">View product <Icon name="arrow" /></a>}
            {mode !== "recipient" && (
              <div className="button-row">
                {mode === "child" && (
                  <ActionForm intent="set-purchased">
                    <input type="hidden" name="itemId" value={item.id} />
                    <input type="hidden" name="purchased" value={item.purchased ? "no" : "yes"} />
                    <Submit intent="set-purchased" appearance="button-secondary">
                      {item.purchased ? "Mark as unpurchased" : "Mark as purchased"}
                    </Submit>
                  </ActionForm>
                )}
                <ActionForm intent="delete-item">
                  <input type="hidden" name="itemId" value={item.id} />
                  <Submit intent="delete-item" appearance="button-quiet">Remove wish</Submit>
                </ActionForm>
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function AddWish({ values, resetValues, childId }: { values: Values; resetValues?: Values; childId?: string }) {
  const submitted = fieldsFor(values, "add-item");
  const fields = (submitted?.childId || undefined) === childId ? submitted : undefined;
  const saved = fieldsFor(resetValues, "add-item");
  const resetOn = (saved?.childId || undefined) === childId ? saved : undefined;
  return (
    <details className="action-detail" open={Boolean(fields) || undefined}>
      <summary>Add a wish</summary>
      <ActionForm intent="add-item" upload className="form-stack" resetOn={resetOn}>
        {childId && <input type="hidden" name="childId" value={childId} />}
        <label>Item name
          <input name="name" defaultValue={fields?.name} maxLength={140} required />
        </label>
        <label>Description <span className="optional">(optional)</span>
          <textarea name="description" rows={2} defaultValue={fields?.description} maxLength={1000} />
        </label>
        <label>Product link <span className="optional">(optional)</span>
          <input name="url" inputMode="url" autoCapitalize="off" spellCheck={false} defaultValue={fields?.url} maxLength={2048} />
        </label>
        <label>Photo <span className="optional">(optional)</span>
          <input name="photo" type="file" accept="image/jpeg,image/png,image/gif" />
          <span className="field-note">Choose a JPG, PNG, or GIF up to 5 MB.</span>
        </label>
        <Submit intent="add-item">Add wish</Submit>
      </ActionForm>
    </details>
  );
}

function MailingAddress({ address }: { address: Address }) {
  return (
    <address>
      {address.firstName} {address.lastName}<br />
      {address.line1}<br />
      {address.line2 && <>{address.line2}<br /></>}
      {address.city}, {address.region} {address.postalCode}
    </address>
  );
}

function AddressEditor({ address, values, resetValues }: { address: Address | null; values: Values; resetValues?: Values }) {
  const fields = fieldsFor(values, "save-address");
  return (
    <details className="action-detail" open={Boolean(fields) || undefined}>
      <summary>{address ? "Edit mailing address" : "Add a mailing address"}</summary>
      <p>Your mailing address is optional. Only your assigned giver can see it.</p>
      <ActionForm intent="save-address" className="form-stack" resetOn={fieldsFor(resetValues, "save-address")}>
        <div className="field-pair">
          <label>First name
            <input name="firstName" autoComplete="given-name" defaultValue={fields?.firstName ?? address?.firstName} maxLength={80} required />
          </label>
          <label>Last name
            <input name="lastName" autoComplete="family-name" defaultValue={fields?.lastName ?? address?.lastName} maxLength={80} required />
          </label>
        </div>
        <label>Street address
          <input name="line1" autoComplete="address-line1" defaultValue={fields?.line1 ?? address?.line1} maxLength={140} required />
        </label>
        <label>Apartment, suite, etc. <span className="optional">(optional)</span>
          <input name="line2" autoComplete="address-line2" defaultValue={fields?.line2 ?? address?.line2} maxLength={140} />
        </label>
        <div className="field-pair">
          <label>City
            <input name="city" autoComplete="address-level2" defaultValue={fields?.city ?? address?.city} maxLength={100} required />
          </label>
          <label>State or region
            <input name="region" autoComplete="address-level1" defaultValue={fields?.region ?? address?.region} maxLength={100} required />
          </label>
        </div>
        <label>ZIP or postal code
          <input name="postalCode" autoComplete="postal-code" defaultValue={fields?.postalCode ?? address?.postalCode} maxLength={24} required />
        </label>
        <Submit intent="save-address">Save address</Submit>
      </ActionForm>
    </details>
  );
}

function Invitations({ group, inviteUrl, values, resetValues }: {
  group: DashboardData["exchange"]["group"];
  inviteUrl: string;
  values: Values;
  resetValues?: Values;
}) {
  const [canShare, setCanShare] = useState(false);
  const [shareMessage, setShareMessage] = useState("");
  const link = useRef<HTMLInputElement>(null);
  const fields = fieldsFor(values, "invite");

  useEffect(() => {
    const content = { url: inviteUrl };
    setCanShare(typeof navigator.share === "function" && (navigator.canShare?.(content) ?? true));
  }, [inviteUrl]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setShareMessage("Invitation link copied.");
    } catch {
      link.current?.focus();
      link.current?.select();
      setShareMessage("The link is selected. Copy it using your device’s copy command.");
    }
  }

  async function share() {
    try {
      await navigator.share({ title: group.name, text: "Join our Secret Santa exchange.", url: inviteUrl });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setShareMessage("Use Copy link or email the invitation.");
    }
  }

  return (
    <section className="dashboard-section invite-section" id="invitations" aria-labelledby="invitations-heading">
      <span className="section-icon"><Icon name="share" /></span>
      <h2 id="invitations-heading">Invite your people</h2>
      <p>Send the link or tell them the group code.</p>
      <p className="group-code">Group code <strong>{group.code}</strong></p>
      <label>Invitation link
        <input ref={link} readOnly value={inviteUrl} onFocus={event => event.currentTarget.select()} />
      </label>
      <div className="button-row share-buttons">
        {canShare && <button type="button" className="button" onClick={share}><Icon name="share" /> Share</button>}
        <button type="button" className="button button-secondary" onClick={copy}><Icon name="copy" /> Copy link</button>
        <a className="button button-secondary" href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(inviteUrl)}`} target="_blank" rel="noreferrer">
          <Icon name="facebook" /> Facebook
        </a>
      </div>
      <div className="share-status" role="status">{shareMessage}</div>
      <details className="action-detail" open={Boolean(fields) || undefined}>
        <summary>Email an invitation</summary>
        <ActionForm intent="invite" className="form-stack" resetOn={fieldsFor(resetValues, "invite")}>
          <label>Email address
            <input name="email" type="email" defaultValue={fields?.email} maxLength={254} required />
          </label>
          <Submit intent="invite">Send invitation</Submit>
        </ActionForm>
      </details>
    </section>
  );
}

function Recipient({ data }: { data: DashboardData }) {
  const { season, recipient } = data.exchange;
  const pendingText = !season?.drawId
    ? "Your recipient will appear here after the organizer draws names."
    : season.completed
      ? "This exchange ended without a recipient for you."
      : "You’re waiting for a recipient. If the organizer draws again and you’re included, your match will appear here.";

  return (
    <section className="recipient-section" id="recipient" aria-label="Your Secret Santa draw">
      {recipient ? (
        <details key={season?.drawId} className="recipient-reveal">
          <summary className="reveal-summary">
            <span className="reveal-label">Your Secret Santa draw</span>
            <span className="reveal-title when-closed">A surprise<br />for you</span>
            <span className="reveal-action">
              <span className="when-closed">Unwrap match</span>
              <span className="when-open">Hide match</span>
            </span>
            <WrappedGift />
          </summary>
          <div>
            <div className="recipient-result">
              <p className="reveal-label">You drew</p>
              <h2 className="recipient-name">{recipient.name}</h2>
            </div>
            <div className="recipient-details">
              <div>
                <h3><Icon name="pin" /> Mailing address</h3>
                {data.recipientAddress ? <MailingAddress address={data.recipientAddress} /> : <p className="empty-line">{recipient.name} hasn’t added a mailing address.</p>}
              </div>
              <div>
                <h3>Wish list</h3>
                <WishList items={data.recipientItems} mode="recipient" empty="Their wish list is empty for now." />
              </div>
            </div>
          </div>
        </details>
      ) : (
        <div className="reveal-waiting">
          <h2>Your Secret Santa draw</h2>
          <p>{pendingText}</p>
          <WrappedGift />
        </div>
      )}
    </section>
  );
}

function LittleOnes({ children, values, resetValues }: { children: DashboardData["children"]; values: Values; resetValues?: Values }) {
  const fields = fieldsFor(values, "add-child");
  return (
    <section className="dashboard-section" id="little-ones" aria-labelledby="little-ones-heading">
      <span className="section-icon"><Icon name="users" /></span>
      <h2 id="little-ones-heading">Little Ones</h2>
      <p>Everyone in the group can add wishes and mark gifts as purchased.</p>
      {children.length === 0 && <p className="empty-line">Add a child to start their wish list.</p>}
      <ul className="child-list">
        {children.map(child => (
          <li className="child" key={child.id}>
            <h3>{child.name} <span className="section-note">Age {child.age}</span></h3>
            <WishList items={child.items} mode="child" empty="No wishes yet." />
            <AddWish values={values} resetValues={resetValues} childId={child.id} />
          </li>
        ))}
      </ul>
      <details className="action-detail" open={Boolean(fields) || undefined}>
        <summary>Add a child</summary>
        <ActionForm intent="add-child" className="form-stack" resetOn={fieldsFor(resetValues, "add-child")}>
          <label>Display name
            <input name="name" defaultValue={fields?.name} maxLength={100} required />
          </label>
          <label>Age
            <input name="age" type="number" min="0" max="120" step="1" inputMode="numeric" defaultValue={fields?.age} required />
          </label>
          <Submit intent="add-child">Add child</Submit>
        </ActionForm>
      </details>
    </section>
  );
}

type Season = NonNullable<DashboardData["exchange"]["season"]>;

function SeasonFields({ season, includeDraw = false }: { season: Season; includeDraw?: boolean }) {
  return (
    <>
      <input type="hidden" name="seasonId" value={season.id} />
      <input type="hidden" name="revision" value={season.revision} />
      {includeDraw && season.drawId && <input type="hidden" name="drawId" value={season.drawId} />}
    </>
  );
}

function Organizer({ data, values, resetValues }: { data: DashboardData; values: Values; resetValues?: Values }) {
  const { season, members, exclusions, waitingCount, mailFailures } = data.exchange;
  const isOpen = Boolean(season && !season.completed);
  const changesPending = Boolean(season?.drawId && season.revision !== season.drawRevision);
  const nextYear = fieldsFor(values, "start-season")?.year ?? (season ? season.year + 1 : undefined);
  const pairFields = fieldsFor(values, "add-exclusion");
  const memberNames = new Map(members.map(member => [member.id, member.name]));

  return (
    <section className="dashboard-section organizer" id="organizer" aria-labelledby="organizer-heading">
      <div className="section-heading">
        <span className="section-icon"><Icon name="users" /></span>
        <div>
          <h2 id="organizer-heading">Organizer tools</h2>
          <p>Manage the adult roster, exclusions, and annual draw.</p>
        </div>
      </div>
      {mailFailures > 0 && (
        <p className="feedback feedback-warning">{mailFailures === 1 ? "1 group email couldn’t be delivered." : `${mailFailures} group emails couldn’t be delivered.`}</p>
      )}
      {isOpen && changesPending && (
        <p className="feedback feedback-warning">Roster or exclusion changes are waiting for a redraw. Published recipients are still available.</p>
      )}
      <div className="organizer-grid">
        <div className="organizer-box">
          <h3>{isOpen ? "Adult roster" : "Group members"}</h3>
          {season && isOpen ? (
            <ActionForm intent="set-roster" className="form-stack" key={`${season.id}-${season.revision}`}>
              <SeasonFields season={season} />
              <p>Select everyone who should give and receive a gift in this draw.</p>
              <ul className="roster">
                {members.map(member => (
                  <li key={member.id}>
                    <label className="check-line">
                      <input type="checkbox" name="memberId" value={member.id} defaultChecked={member.eligible} />
                      <span><strong>{member.name}</strong><span className="member-email">{member.email}</span></span>
                    </label>
                  </li>
                ))}
              </ul>
              <Submit intent="set-roster" appearance="button-secondary">Save roster</Submit>
            </ActionForm>
          ) : (
            <ul className="roster">
              {members.map(member => (
                <li className="member-line" key={member.id}>
                  <strong>{member.name}</strong><span className="member-email">{member.email}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="organizer-box">
          <h3>Pair exclusions</h3>
          <p>Adults in a blocked pair can’t draw each other. Exclusions carry over to the next exchange.</p>
          {exclusions.length > 0 && (
            <ul className="exclusions">
              {exclusions.map(pair => (
                <li key={`${pair.firstId}-${pair.secondId}`}>
                  <span>{memberNames.get(pair.firstId)} and {memberNames.get(pair.secondId)}</span>
                  <ActionForm intent="remove-exclusion">
                    <input type="hidden" name="firstId" value={pair.firstId} />
                    <input type="hidden" name="secondId" value={pair.secondId} />
                    <Submit intent="remove-exclusion" appearance="button-quiet">Remove exclusion</Submit>
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
          {members.length >= 2 && (
            <details className="action-detail" open={Boolean(pairFields) || undefined}>
              <summary>Block a pair</summary>
              <ActionForm intent="add-exclusion" className="form-stack" resetOn={fieldsFor(resetValues, "add-exclusion")}>
                <div className="field-pair">
                  <label>First adult
                    <select name="firstId" defaultValue={pairFields?.firstId ?? ""} required>
                      <option value="">Choose an adult</option>
                      {members.map(member => <option value={member.id} key={member.id}>{member.name}</option>)}
                    </select>
                  </label>
                  <label>Second adult
                    <select name="secondId" defaultValue={pairFields?.secondId ?? ""} required>
                      <option value="">Choose an adult</option>
                      {members.map(member => <option value={member.id} key={member.id}>{member.name}</option>)}
                    </select>
                  </label>
                </div>
                <Submit intent="add-exclusion" appearance="button-secondary">Save exclusion</Submit>
              </ActionForm>
            </details>
          )}
        </div>
        <div className="organizer-box draw-controls">
          <h3>{isOpen ? "Draw names" : "Start an exchange"}</h3>
          {season && isOpen ? (
            <>
              <p>Everyone on the roster gives and receives once. The draw also blocks repeat matches from the last completed exchange.</p>
              <ActionForm intent="draw" className="form-stack" key={`${season.id}-${season.revision}-${season.drawId}`}>
                <SeasonFields season={season} includeDraw />
                <input type="hidden" name="requestId" value={data.requestId} />
                {season.drawId && (
                  <label className="check-line">
                    <input name="confirm" type="checkbox" value="yes" required />
                    <span>I understand everyone’s recipient can change.</span>
                  </label>
                )}
                <Submit intent="draw">{season.drawId ? "Redraw names" : "Draw names"}</Submit>
              </ActionForm>
              {season.drawId ? (
                <details className="action-detail" open={Boolean(fieldsFor(values, "complete-season")) || undefined}>
                  <summary>Complete this exchange</summary>
                  <p>
                    {waitingCount === 0 ? "Everyone on the roster has a published recipient." : `${waitingCount} ${waitingCount === 1 ? "adult is" : "adults are"} still waiting for a recipient.`}
                    {changesPending && " Some roster or exclusion changes haven’t been applied."}
                  </p>
                  <ActionForm intent="complete-season" className="form-stack" key={`${season.id}-${season.revision}-${season.drawId}`}>
                    <SeasonFields season={season} includeDraw />
                    <label className="check-line">
                      <input name="confirm" type="checkbox" value="yes" required />
                      <span>Finish the exchange with the currently published draw.</span>
                    </label>
                    <Submit intent="complete-season" appearance="button-secondary">Complete exchange</Submit>
                  </ActionForm>
                </details>
              ) : (
                <details className="action-detail" open={Boolean(fieldsFor(values, "discard-season")) || undefined}>
                  <summary>Discard this exchange</summary>
                  <p>The group, its wish lists, and its exclusions will stay available.</p>
                  <ActionForm intent="discard-season" className="form-stack" key={`${season.id}-${season.revision}`}>
                    <SeasonFields season={season} />
                    <label className="check-line">
                      <input name="confirm" type="checkbox" value="yes" required />
                      <span>Discard the {season.year} exchange and its roster.</span>
                    </label>
                    <Submit intent="discard-season" appearance="button-danger">Discard exchange</Submit>
                  </ActionForm>
                </details>
              )}
            </>
          ) : (
            <>
              <p>{season ? "The new roster starts with the adults from your last completed draw." : "Choose a year to open the next draw."}</p>
              <ActionForm intent="start-season" className="form-stack">
                <label>Exchange year
                  <input type="number" name="year" step="1" inputMode="numeric" min={season ? season.year + 1 : 1000} max={9999} defaultValue={nextYear} required />
                </label>
                <Submit intent="start-season">Start exchange</Submit>
              </ActionForm>
            </>
          )}
        </div>
      </div>
      <details className="action-detail danger-detail" open={Boolean(fieldsFor(values, "delete-group")) || undefined}>
        <summary>Delete group</summary>
        <p>This permanently deletes the group, its exchanges, addresses, and wish lists.</p>
        <ActionForm intent="delete-group" className="form-stack">
          <input type="hidden" name="groupId" value={data.exchange.group.id} />
          <label className="check-line">
            <input name="confirm" type="checkbox" value="yes" required />
            <span>Delete this group and its exchange data.</span>
          </label>
          <Submit intent="delete-group" appearance="button-danger">Delete group</Submit>
        </ActionForm>
      </details>
    </section>
  );
}

export function Dashboard({ data, message, error, values: submitted }: DashboardProps) {
  const { group, self, season } = data.exchange;
  const organizer = self.role === "organizer";
  const values = error ? submitted : {};
  const resetValues = message ? submitted : undefined;
  const feedback = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error || message) feedback.current?.focus();
  }, [error, message, submitted]);

  return (
    <MembershipContext value={self.id}>
      <div className="dashboard">
        <div className="dashboard-top">
          <p className="section-note">Hi, {self.name}</p>
          <SignOut />
          <h1>{group.name}</h1>
          {group.description && <p className="group-description multiline">{group.description}</p>}
        </div>
        <div className="exchange-status">
          <span>{season ? `${season.year} exchange` : "Annual exchange"}</span>
          <span className={`tag ${season?.drawId ? "tag-active" : ""}`}>
            {season?.completed ? "Completed" : season?.drawId ? "Names drawn" : season ? "Waiting for the draw" : "Waiting for the next exchange"}
          </span>
        </div>
        {(error || message) && <div className="dashboard-feedback" tabIndex={-1} ref={feedback}><Feedback error={error} message={message} /></div>}
        <Recipient data={data} />
        <nav className="dashboard-nav" aria-label="In this exchange">
          <a href="#wish-list">My wish list</a>
          <a href="#little-ones">Little Ones</a>
          <a href="#invitations">Invitations</a>
          {organizer && <a href="#organizer">Organizer</a>}
        </nav>
        <div className="dashboard-columns">
          <section className="dashboard-section" id="wish-list" aria-labelledby="wish-list-heading">
            <span className="section-icon"><Icon name="gift" /></span>
            <h2 id="wish-list-heading">My wish list</h2>
            <p>Your assigned giver can see your latest wishes here.</p>
            <WishList items={data.items} mode="adult" empty="Add a wish to give your Secret Santa an idea." />
            <AddWish values={values} resetValues={resetValues} />
            <AddressEditor address={data.address} values={values} resetValues={resetValues} />
          </section>
          <LittleOnes children={data.children} values={values} resetValues={resetValues} />
        </div>
        <Invitations group={group} inviteUrl={data.inviteUrl} values={values} resetValues={resetValues} />
        {organizer && <Organizer data={data} values={values} resetValues={resetValues} />}
      </div>
    </MembershipContext>
  );
}
