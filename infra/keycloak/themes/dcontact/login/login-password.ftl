<#--
  #515: login-password.ftl of the base (Keycloak 26.0.0, adapted to 26.7.5 in #592) — the second step of the tenant login after entering the email
  adapted to design B; #password, name="password" and #kc-login unchanged
-->
<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=!messagesPerField.existsError('password'); section>
    <#if section = "header">
        ${msg("dcLoginTitle")}
    <#elseif section = "subtitle">
        ${msg("dcPasswordSubtitle")}
    <#elseif section = "form">
        <div id="kc-form">
            <div id="kc-form-wrapper">
                <form id="kc-form-login" class="${properties.kcFormClass!}" onsubmit="login.disabled = true; return true;" action="${url.loginAction}"
                      method="post">
                    <div class="${properties.kcFormGroupClass!}">
                        <div class="dc-label-row">
                            <label for="password" class="${properties.kcLabelClass!}">${msg("password")}</label>
                            <#if realm.resetPasswordAllowed>
                                <a tabindex="5" class="dc-link-sm" href="${url.loginResetCredentialsUrl}">${msg("doForgotPassword")}</a>
                            </#if>
                        </div>
                        <div class="${properties.kcInputGroup!}" dir="ltr">
                            <input tabindex="2" id="password" class="${properties.kcInputClass!}" name="password"
                                   type="password" autocomplete="current-password" autofocus
                                   aria-invalid="<#if messagesPerField.existsError('password')>true</#if>"
                            />
                            <button class="${properties.kcFormPasswordVisibilityButtonClass!}" type="button" aria-label="${msg('showPassword')}"
                                    aria-controls="password"  data-password-toggle tabindex="3"
                                    data-icon-show="${properties.kcFormPasswordVisibilityIconShow!}" data-icon-hide="${properties.kcFormPasswordVisibilityIconHide!}"
                                    data-label-show="${msg('showPassword')}" data-label-hide="${msg('hidePassword')}">
                                <i class="${properties.kcFormPasswordVisibilityIconShow!}" aria-hidden="true"></i>
                            </button>
                        </div>
                        <#if messagesPerField.existsError('password')>
                            <span id="input-error-password" class="${properties.kcInputErrorMessageClass!}" aria-live="polite">
                                ${kcSanitize(messagesPerField.get('password'))?no_esc}
                            </span>
                        </#if>
                    </div>

                    <div id="kc-form-buttons" class="${properties.kcFormGroupClass!} ${properties.kcFormButtonsClass!}">
                        <input tabindex="4" class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!} ${properties.kcButtonBlockClass!} ${properties.kcButtonLargeClass!}" name="login" id="kc-login" type="submit" value="${msg("doLogIn")}"/>
                    </div>

                    <p class="dc-help">${msg("dcLoginHelp")}</p>
                </form>
            </div>
        </div>
        <script type="module" src="${url.resourcesPath}/js/passwordVisibility.js"></script>
    </#if>

</@layout.registrationLayout>
