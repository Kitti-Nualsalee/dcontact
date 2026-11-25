package io.dcontact.keycloak;

import java.util.Arrays;
import org.keycloak.TokenVerifier;
import org.keycloak.authentication.actiontoken.ActionTokenContext;
import org.keycloak.authentication.actiontoken.TokenUtils;
import org.keycloak.authentication.actiontoken.execactions.ExecuteActionsActionToken;
import org.keycloak.authentication.actiontoken.execactions.ExecuteActionsActionTokenHandler;
import org.keycloak.events.Errors;
import org.keycloak.models.UserModel;
import org.keycloak.services.messages.Messages;

/**
 * A1.4b (#436): an execute-actions link (the first admin's invitation) must not grant permission again (#392)
 *
 * <p>Keycloak 26.0 lets a link that has not expired set a password/add an OTP even though the user is already activated
 * this handler replaces the existing one (same provider id, higher order) and adds two checks:
 *
 * <ol>
 *   <li>the user must still have at least one pending required action that the link names — once activation is complete =
 *       every generation of links is unusable
 *   <li>the {@code iat} of the link must not be older than the user attribute {@code dc_invitation_not_before} (epoch
 *       seconds) that the control plane sets on resend — a superseded generation is unusable even before activation
 * </ol>
 *
 * <p>Rejected the same way as an expired link, without giving the link holder a specific reason
 */
public class InvitationGuardActionTokenHandler extends ExecuteActionsActionTokenHandler {

  public static final String NOT_BEFORE_ATTRIBUTE = "dc_invitation_not_before";

  @Override
  public int order() {
    // higher than Keycloak's existing one (0), so it is chosen for the provider id "execute-actions"
    return 100;
  }

  @Override
  @SuppressWarnings("unchecked")
  public TokenVerifier.Predicate<? super ExecuteActionsActionToken>[] getVerifiers(
      ActionTokenContext<ExecuteActionsActionToken> context) {
    TokenVerifier.Predicate<? super ExecuteActionsActionToken>[] base = super.getVerifiers(context);
    TokenVerifier.Predicate<? super ExecuteActionsActionToken>[] all =
        Arrays.copyOf(base, base.length + 2);
    all[base.length] =
        TokenUtils.checkThat(
            (ExecuteActionsActionToken token) -> stillPending(context, token),
            Errors.EXPIRED_CODE,
            Messages.EXPIRED_ACTION);
    all[base.length + 1] =
        TokenUtils.checkThat(
            (ExecuteActionsActionToken token) -> notSuperseded(context, token),
            Errors.EXPIRED_CODE,
            Messages.EXPIRED_ACTION);
    return TokenUtils.predicates(all);
  }

  private static UserModel user(
      ActionTokenContext<ExecuteActionsActionToken> context, ExecuteActionsActionToken token) {
    return context.getSession().users().getUserById(context.getRealm(), token.getSubject());
  }

  static boolean stillPending(
      ActionTokenContext<ExecuteActionsActionToken> context, ExecuteActionsActionToken token) {
    UserModel user = user(context, token);
    if (user == null || token.getRequiredActions() == null) return false;
    return user.getRequiredActionsStream().anyMatch(token.getRequiredActions()::contains);
  }

  static boolean notSuperseded(
      ActionTokenContext<ExecuteActionsActionToken> context, ExecuteActionsActionToken token) {
    UserModel user = user(context, token);
    if (user == null) return false;
    String notBefore = user.getFirstAttribute(NOT_BEFORE_ATTRIBUTE);
    if (notBefore == null || notBefore.isBlank()) return true;
    try {
      Long issuedAt = token.getIat();
      return issuedAt != null && issuedAt >= Long.parseLong(notBefore.trim());
    } catch (NumberFormatException invalid) {
      // a corrupt value = reject (fail closed)
      return false;
    }
  }
}
