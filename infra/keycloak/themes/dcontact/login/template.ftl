<#--
  #515: layout ของทุกหน้าใน login theme (login, OTP, required actions ของคำเชิญ, error, info)
  แทน template.ftl ของ base แต่คง contract ที่ test และ script อ่านอยู่:
  - `<h1 id="kc-page-title">` (keycloak-test-support.ts อ่านชื่อหน้า)
  - `<form>` แรกของหน้าเป็นฟอร์มของหน้านั้นเอง (keycloak-platform-login.mjs และ completeInvitation อ่าน action จาก form แรก)
    — ตัวเลือกภาษาจึงเป็นลิงก์ ไม่ใช่ form และอยู่หลังเนื้อหา (ลิงก์ action-token ลิงก์แรกต้องเป็นของหน้า)
  - section ที่หน้าต่างๆ ส่งมา: header, show-username, form, socialProviders, info (+ subtitle ของหน้าที่ theme นี้ override)
-->
<#import "footer.ftl" as loginFooter>
<#macro registrationLayout bodyClass="" displayInfo=false displayMessage=true displayRequiredFields=false>
<#assign dcPlatform = (properties.dcVariant!'') == 'platform'>
<#assign dcHeader><#nested "header"></#assign>
<#assign dcSubtitle><#nested "subtitle"></#assign>
<!DOCTYPE html>
<html class="${properties.kcHtmlClass!}" lang="${lang}"<#if realm.internationalizationEnabled> dir="${(locale.rtl)?then('rtl','ltr')}"</#if>>
<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="robots" content="noindex, nofollow">
    <#if properties.meta?has_content>
        <#list properties.meta?split(' ') as meta>
            <meta name="${meta?split('==')[0]}" content="${meta?split('==')[1]}"/>
        </#list>
    </#if>
    <title>${msg("loginTitle",(realm.displayName!''))}</title>
    <link rel="icon" href="${url.resourcesPath}/img/favicon.ico" />
    <#if properties.stylesCommon?has_content>
        <#list properties.stylesCommon?split(' ') as style>
            <link href="${url.resourcesCommonPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if properties.styles?has_content>
        <#list properties.styles?split(' ') as style>
            <link href="${url.resourcesPath}/${style}" rel="stylesheet" />
        </#list>
    </#if>
    <#if properties.scripts?has_content>
        <#list properties.scripts?split(' ') as script>
            <script src="${url.resourcesPath}/${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <script type="importmap">
        {
            "imports": {
                "rfc4648": "${url.resourcesCommonPath}/vendor/rfc4648/rfc4648.js"
            }
        }
    </script>
    <#if scripts??>
        <#list scripts as script>
            <script src="${script}" type="text/javascript"></script>
        </#list>
    </#if>
    <#-- #592: authChecker.js ของ Keycloak 26.7 (startSessionPolling + checkAuthSession แทน checkCookiesAndSetTimer) -->
    <script type="module">
        <#outputformat "JavaScript">
        import { startSessionPolling } from ${(url.resourcesPath + "/js/authChecker.js")?c};

        startSessionPolling(
            ${url.ssoLoginInOtherTabsUrl?c}
        );
        </#outputformat>
    </script>
    <script type="module">
        document.addEventListener("click", (event) => {
            const link = event.target.closest("a[data-once-link]");

            if (!link) {
                return;
            }

            if (link.getAttribute("aria-disabled") === "true") {
                event.preventDefault();
                return;
            }

            const { disabledClass } = link.dataset;

            if (disabledClass) {
                link.classList.add(...disabledClass.trim().split(/\s+/));
            }

            link.setAttribute("role", "link");
            link.setAttribute("aria-disabled", "true");
        });
    </script>
    <#if authenticationSession??>
        <script type="module">
            <#outputformat "JavaScript">
            import { checkAuthSession } from ${(url.resourcesPath + "/js/authChecker.js")?c};

            checkAuthSession(
                ${authenticationSession.authSessionIdHash?c}
            );
            </#outputformat>
        </script>
    </#if>
</head>

<body class="${properties.kcBodyClass!}<#if dcPlatform> dc-body--platform</#if>" data-page-id="login-${pageId}">
<div class="dc-shell">
    <aside class="dc-brand" aria-label="D-Contact">
        <div class="dc-brand__body">
            <#if dcPlatform>
                <span class="dc-badge">
                    <span class="dc-icon dc-icon--shield" aria-hidden="true"></span>${msg("dcPlatformBadge")}
                </span>
                <p class="dc-brand__title">${msg("dcPlatformTitle")}</p>
                <p class="dc-brand__lead">${msg("dcPlatformLead")}</p>
            <#else>
                <p class="dc-brand__title">${msg("dcBrandTitle")}</p>
                <p class="dc-brand__lead">${msg("dcBrandLead")}</p>
            </#if>
        </div>
        <p class="dc-brand__footer"><#if dcPlatform>${msg("dcPlatformFooter")}<#else>${msg("dcBrandFooter")}</#if></p>
    </aside>

    <main class="dc-main">
        <div class="dc-panel">
            <div class="dc-logo">
                <img class="dc-logo__mark" src="${url.resourcesPath}/img/logo.png" alt="" width="40" height="40">
                <span class="dc-logo__name">D-Contact</span>
            </div>

            <header class="dc-header">
                <#if displayRequiredFields>
                    <p class="dc-required"><span class="required">*</span> ${msg("requiredFields")}</p>
                </#if>
                <#if dcHeader?markup_string?trim?has_content>
                    <h1 id="kc-page-title">${dcHeader}</h1>
                </#if>
                <#if dcSubtitle?markup_string?trim?has_content>
                    <p class="dc-subtitle">${dcSubtitle}</p>
                </#if>
                <#if auth?has_content && auth.showUsername() && !auth.showResetCredentials()>
                    <#nested "show-username">
                    <div id="kc-username" class="dc-username">
                        <label id="kc-attempted-username">${auth.attemptedUsername}</label>
                        <a id="reset-login" href="${url.loginRestartFlowUrl}" aria-label="${msg("restartLoginTooltip")}">
                            <span class="${properties.kcResetFlowIcon!}" aria-hidden="true"></span>
                            <span class="dc-username__action">${msg("restartLoginTooltip")}</span>
                        </a>
                    </div>
                </#if>
            </header>

            <div id="kc-content">
                <div id="kc-content-wrapper">
                    <#-- App-initiated actions should not see warning messages about the need to complete the action during login. -->
                    <#if displayMessage && message?has_content && (message.type != 'warning' || !isAppInitiatedAction??)>
                        <div class="${properties.kcAlertClass!} dc-alert--${message.type}" role="<#if message.type = 'error'>alert<#else>status</#if>">
                            <#if message.type = 'success'><span class="${properties.kcFeedbackSuccessIcon!}" aria-hidden="true"></span></#if>
                            <#if message.type = 'warning'><span class="${properties.kcFeedbackWarningIcon!}" aria-hidden="true"></span></#if>
                            <#if message.type = 'error'><span class="${properties.kcFeedbackErrorIcon!}" aria-hidden="true"></span></#if>
                            <#if message.type = 'info'><span class="${properties.kcFeedbackInfoIcon!}" aria-hidden="true"></span></#if>
                            <span class="${properties.kcAlertTitleClass!}">${kcSanitize(message.summary)?no_esc}</span>
                        </div>
                    </#if>

                    <#nested "form">

                    <#if auth?has_content && auth.showTryAnotherWayLink()>
                        <form id="kc-select-try-another-way-form" action="${url.loginAction}" method="post">
                            <div class="${properties.kcFormGroupClass!}">
                                <input type="hidden" name="tryAnotherWay" value="on"/>
                                <a href="#" id="try-another-way"
                                   onclick="document.forms['kc-select-try-another-way-form'].requestSubmit();return false;">${msg("doTryAnotherWay")}</a>
                            </div>
                        </form>
                    </#if>

                    <#nested "socialProviders">

                    <#if displayInfo>
                        <div id="kc-info" class="${properties.kcSignUpClass!}">
                            <div id="kc-info-wrapper" class="${properties.kcInfoAreaWrapperClass!}">
                                <#nested "info">
                            </div>
                        </div>
                    </#if>
                </div>
            </div>

            <@loginFooter.content/>
        </div>
        <#-- ตัวเลือกภาษาอยู่หลังเนื้อหาใน DOM (CSS ยกขึ้นไปมุมขวาบน): URL ของมันมี action-token ด้วย
             และ completeInvitation ใน keycloak-test-support.ts ตามลิงก์ action-token ลิงก์แรกของหน้า -->
        <#if realm.internationalizationEnabled && locale.supported?size gt 1>
            <nav id="kc-locale" class="dc-locale" aria-label="${msg("languages")}">
                <#list locale.supported as l>
                    <#if l?index gt 0><span class="dc-locale__sep" aria-hidden="true">|</span></#if>
                    <#if l.languageTag == locale.currentLanguageTag>
                        <a class="dc-locale__link dc-locale__link--current" href="${l.url}" aria-current="true">${l.label}</a>
                    <#else>
                        <a class="dc-locale__link" href="${l.url}">${l.label}</a>
                    </#if>
                </#list>
            </nav>
        </#if>
    </main>
</div>
</body>
</html>
</#macro>
