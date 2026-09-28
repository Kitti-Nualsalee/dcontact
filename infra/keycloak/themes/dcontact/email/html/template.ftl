<#--
  #522: layout ของอีเมล HTML — table + inline style เพราะ mail client ไม่รองรับ stylesheet และ var()
  ค่าสี/ตัวอักษรมาจาก dc-tokens.ftl (สร้างจาก packages/ui/src/tokens.css) — ห้ามเขียนค่าตรงในไฟล์นี้
  โลโก้เป็นตัวอักษร "D-Contact" ไม่ใช้รูป (ไม่ต้องมี URL สาธารณะ และ Keycloak แนบรูปแบบ CID ไม่ได้)
-->
<#import "dc-tokens.ftl" as tokens>
<#assign dc = tokens.dc>
<#assign dcFont = "font-family:${dc['font-sans']};">

<#macro emailLayout>
<!DOCTYPE html>
<html lang="${(locale.language)!'th'}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:${dc['surface-page']};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${dc['surface-page']};">
    <tr>
        <td align="center" style="padding:${dc['space-9']} ${dc['space-6']};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="max-width:560px;background:${dc['surface-raised']};border:1px solid ${dc['border-subtle']};border-top:4px solid ${dc['surface-brand']};border-radius:${dc['radius-xl']};">
                <tr>
                    <td style="padding:${dc['space-8']} ${dc['space-9']} 0;${dcFont}font-size:${dc['text-xl']};font-weight:${dc['weight-bold']};color:${dc['text-brand']};">D-Contact</td>
                </tr>
                <tr>
                    <td style="padding:${dc['space-6']} ${dc['space-9']} ${dc['space-9']};${dcFont}font-size:${dc['text-md']};line-height:${dc['leading-normal']};color:${dc['text-primary']};">
                        <#nested>
                    </td>
                </tr>
            </table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
                <tr>
                    <td style="padding:${dc['space-6']} ${dc['space-9']};${dcFont}font-size:${dc['text-xs']};line-height:${dc['leading-normal']};color:${dc['text-muted']};">${msg("dcEmailFooter")}</td>
                </tr>
            </table>
        </td>
    </tr>
</table>
</body>
</html>
</#macro>

<#macro heading>
<h1 style="margin:0 0 ${dc['space-5']};${dcFont}font-size:${dc['text-lg']};line-height:${dc['leading-snug']};font-weight:${dc['weight-semibold']};color:${dc['text-primary']};"><#nested></h1>
</#macro>

<#macro paragraph>
<p style="margin:0 0 ${dc['space-6']};"><#nested></p>
</#macro>

<#macro steps items>
<ol style="margin:0 0 ${dc['space-8']};padding-left:${dc['space-8']};">
    <#list items as item>
        <li style="margin:0 0 ${dc['space-2']};">${item}</li>
    </#list>
</ol>
</#macro>

<#macro button href>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${dc['space-8']};">
    <tr>
        <td style="background:${dc['surface-brand']};border-radius:${dc['radius-md']};">
            <a href="${href}" target="_blank"
               style="display:inline-block;padding:${dc['space-5']} ${dc['space-8']};${dcFont}font-size:${dc['text-md']};font-weight:${dc['weight-semibold']};color:${dc['text-on-brand']};text-decoration:none;"><#nested></a>
        </td>
    </tr>
</table>
</#macro>

<#macro note>
<p style="margin:0 0 ${dc['space-5']};font-size:${dc['text-sm']};color:${dc['text-secondary']};"><#nested></p>
</#macro>

<#macro link href>
<a href="${href}" style="color:${dc['text-brand']};word-break:break-all;">${href}</a>
</#macro>
