<#--
  AC6 (#599): email verification mail (VERIFY_EMAIL resent / sent by the user themself) — the same layout as the invitation mail
  does not show the realm/user/email; the link and link lifetime are the same as the base template
-->
<#import "template.ftl" as layout>
<@layout.emailLayout>
    <@layout.heading>${msg("dcVerifyTitle")}</@layout.heading>
    <@layout.paragraph>${msg("dcVerifyIntro")}</@layout.paragraph>
    <@layout.button href=link>${msg("dcVerifyAction")}</@layout.button>
    <@layout.note>${msg("dcVerifyExpiry", linkExpirationFormatter(linkExpiration))}</@layout.note>
    <@layout.note>${msg("dcVerifyIgnore")}</@layout.note>
    <@layout.note>${msg("dcInviteFallback")}<br><@layout.link href=link/></@layout.note>
</@layout.emailLayout>
