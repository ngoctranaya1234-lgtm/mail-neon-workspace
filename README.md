# Mail Neon Workspace

Ứng dụng tự lưu trữ để sinh và quản lý bí danh Gmail dot/plus, đọc Gmail và Outlook/Hotmail đã được cấp quyền, tạo mail tạm trên domain của bạn và trích mã OTP từ **email**. Giao diện dùng được trên Windows và trình duyệt Android khi máy chủ có HTTPS công khai.

Gmail dot trick chỉ đổi cách viết của **cùng một hộp Gmail**; nó không tạo tài khoản Google mới. Mail tạm chỉ nhận thư thật sau khi domain, MX và bộ chuyển tiếp inbound đã hoạt động. Dự án không đọc SMS và không tạo tài khoản Hotmail hàng loạt.

## Chạy trên Windows

Mở thư mục `D:\MailTool`, nhấp đúp `start-windows.cmd` hoặc chạy:

```cmd
D:\MailTool\start-windows.cmd
```

Lệnh tìm Node.js 24+, cài dependency còn thiếu, tạo `.env` và chứng chỉ HTTPS cục bộ nếu chưa có, rồi mở Chrome dạng cửa sổ app tại `https://127.0.0.1:3000`. Giữ cửa sổ lệnh mở để máy chủ chạy. `run.cmd` là lối chạy tương đương trong thư mục dự án.

Chế độ Windows tự đăng nhập chỉ dùng cho máy cục bộ. Vào **Cài đặt** để đặt email và mật khẩu quản trị riêng bằng `SETUP_TOKEN` trong `.env` trước khi cho thiết bị khác truy cập. Mật khẩu cũ cố định của bản trước được đổi sang giá trị ngẫu nhiên khi ứng dụng khởi động.

## Dùng trên Android

Android mở **cùng máy chủ Node.js** qua một domain HTTPS tin cậy. Cấu hình `PUBLIC_BASE_URL=https://ten-mien-cua-ban`, đặt `AUTO_BOOTSTRAP_LOCAL=false`, chạy `pnpm start` và triển khai reverse proxy HTTPS tới Node trên `127.0.0.1:3000`. Đăng nhập bằng email/mật khẩu đã đặt trong Cài đặt trên Windows. Trong Chrome Android, chọn **Thêm vào màn hình chính** để dùng giao diện như app.

## Dùng bộ sinh bí danh trên điện thoại qua GitHub Pages

Mở [Mail Neon trên GitHub Pages](https://ngoctranaya1234-lgtm.github.io/mail-neon-workspace/) bằng Chrome Android hoặc trình duyệt trên máy tính. Trang này sinh Gmail Dot Trick và thẻ Plus, sao chép, tải TXT và có thể thêm vào màn hình chính. Thuật toán chạy trong trình duyệt; địa chỉ Gmail nhập vào không được gửi tới máy chủ. Tệp nguồn nằm trong `pages/`, được đóng gói bằng `pnpm build:pages` và xuất bản bằng GitHub Actions.

GitHub Pages chỉ lưu trang tĩnh, không chạy được SQLite, OAuth callback hoặc webhook. Vì vậy bản Pages **không đọc thư, nhận OTP, kết nối Hotmail hay tạo mail tạm nhận thư**. Những chức năng này thuộc ứng dụng Node.js đầy đủ ở trên, cần máy chủ HTTPS công khai và các tài khoản nhà cung cấp đã cấu hình. Không triển khai riêng thư mục `public/` rồi coi đó là ứng dụng đầy đủ.

## Kết nối Gmail và Hotmail

- **Gmail:** Tạo OAuth Web Client trong Google Cloud, bật Gmail API, đặt redirect URI `{PUBLIC_BASE_URL}/api/v1/oauth/google/callback`, điền `GOOGLE_CLIENT_ID` và `GOOGLE_CLIENT_SECRET` vào `.env`, khởi động lại. Nút **Kết nối Gmail** yêu cầu quyền Gmail chỉ đọc. Bộ sinh dot/plus hoạt động offline, nhưng chỉ lưu vào danh sách nhận thư khi đúng Gmail đó đã được kết nối. [Google OAuth và phạm vi Gmail](https://developers.google.com/workspace/gmail/api/auth/scopes).
- **Outlook/Hotmail:** Đăng ký ứng dụng Microsoft hỗ trợ tài khoản Microsoft cá nhân, đặt redirect URI `{PUBLIC_BASE_URL}/api/v1/oauth/microsoft/callback`, điền `MICROSOFT_CLIENT_ID` và `MICROSOFT_CLIENT_SECRET`. Nút **Kết nối Outlook / Hotmail** dùng quyền delegated `Mail.Read`. [Microsoft Graph Mail.Read](https://learn.microsoft.com/en-us/graph/permissions-reference).
- **IMAP TLS:** Dùng thông tin hộp thư bạn kiểm soát; app kiểm tra kết nối trước khi mã hóa và lưu mật khẩu ứng dụng.

Thiếu Client ID/Secret thì nút OAuth tương ứng bị khóa. Chưa có tài khoản nhà cung cấp hoặc sự đồng ý OAuth thì không thể kiểm thử nhận thư thật từ họ.

## Mail tạm và cổng nhận thư

Đặt `OWNED_MAIL_DOMAIN` trong `.env`; cấu hình MX và Cloudflare Email Routing/Email Worker theo [adapters/README.md](adapters/README.md). Worker chuyển thư vào `/api/v1/inbound` với chữ ký HMAC. Sau khi gửi một thư thử thật và thấy nó trong hộp thư, các nút 15 phút, 1 giờ, 24 giờ, 7 ngày sẽ tạo địa chỉ có hạn dùng trên domain đó. Không có domain thì các nút bị khóa.

Cổng SMTP ở `127.0.0.1:2525` chỉ dành cho kiểm thử hoặc nguồn gửi bạn kiểm soát. Nó **không** tự thay thế MX công khai hoặc nhận trực tiếp từ Gmail/Hotmail. Có thể tắt bằng `ENABLE_SMTP=false`. [Tài liệu smtp-server](https://nodemailer.com/extras/smtp-server).

## Dữ liệu và kiểm thử

`data/workspace.sqlite` chứa metadata và nội dung thư mã hóa; `.env` giữ khóa giải mã. Không đưa `.env`, `data/` hoặc `cert.pfx` lên GitHub. Nút **Dọn nhanh** xóa địa chỉ/phiên hết hạn; **Full Reset** yêu cầu mật khẩu hoặc `SETUP_TOKEN`, tạo bản sao lưu rồi mới xóa thư và địa chỉ. `clean.cmd` chỉ dọn hết hạn và checkpoint; `--all` không còn xóa dữ liệu.

```sh
pnpm test
pnpm smoke:ui
pnpm build
pnpm backup
```

Không có OAuth client, domain, DNS và máy chủ HTTPS công khai trong gói dự án; các kết nối đó phải được cấu hình bằng tài khoản do bạn sở hữu. Xem [docs/STATUS.md](docs/STATUS.md) để biết phần đã kiểm thử và giới hạn còn lại.

