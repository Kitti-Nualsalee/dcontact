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
 * A1.4b (#436): ลิงก์ execute-actions (invitation ของ first admin) ต้องไม่ให้สิทธิ์ซ้ำ (#392)
 *
 * <p>Keycloak 26.0 ยอมให้ลิงก์ที่ยังไม่หมดอายุตั้งรหัสผ่าน/เพิ่ม OTP ได้แม้ผู้ใช้ activate แล้ว
 * handler นี้แทนตัวเดิม (provider id เดียวกัน, order สูงกว่า) และเพิ่มการตรวจสองข้อ:
 *
 * <ol>
 *   <li>ผู้ใช้ต้องยังมี required action ที่ลิงก์ระบุค้างอยู่อย่างน้อยหนึ่งข้อ — activate ครบแล้ว =
 *       ลิงก์ทุกรุ่นใช้ไม่ได้
 *   <li>{@code iat} ของลิงก์ต้องไม่เก่ากว่า user attribute {@code dc_invitation_not_before} (epoch
 *       วินาที) ที่ control plane ตั้งตอน resend — รุ่นที่ถูกแทนแล้วใช้ไม่ได้แม้ยังไม่ activate
 * </ol>
 *
 * <p>ปฏิเสธแบบเดียวกับลิงก์หมดอายุ ไม่บอกเหตุผลเฉพาะกับผู้ถือลิงก์
 */
public class InvitationGuardActionTokenHandler extends ExecuteActionsActionTokenHandler {

  public static final String NOT_BEFORE_ATTRIBUTE = "dc_invitation_not_before";

  @Override
  public int order() {
    // สูงกว่าตัวเดิมของ Keycloak (0) จึงถูกเลือกสำหรับ provider id "execute-actions"
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
      // ค่าเสีย = ปฏิเสธ (fail closed)
      return false;
    }
  }
}
