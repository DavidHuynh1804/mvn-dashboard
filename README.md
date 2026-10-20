# Mvn Dashboard

GUI nhỏ chạy trên localhost để quản lý và build nhiều project Maven độc lập. Không cần `npm install`, chỉ cần Node 18+.

## Chạy nhanh bằng một lệnh

```bash
npx github:DavidHuynh1804/mvn-dashboard
```

Lệnh này mở trình duyệt, sau đó bạn chọn thư mục chứa các project Maven. Mỗi lần chạy, npx đều lấy bản mới nhất từ repo.

Yêu cầu: Node 18+, Java, Maven (`mvn` trong PATH hoặc `mvnw` trong từng project), git (không bắt buộc). Hiện chạy tốt nhất trên macOS. Trên Linux thì build được, nhưng không có nút Finder và không tự chọn JDK. Windows chưa hỗ trợ.

## Chạy từ source

```bash
node server.js                  # mở trình duyệt, chọn folder trên giao diện
node server.js --root ~/code/be # mở luôn folder này
#   --port 8765   --no-browser
```

Có thể cài thành lệnh dùng ở bất kỳ đâu:

```bash
cd mvn-dashboard && npm link    # sau đó chỉ cần gõ: mvn-dashboard
```

## Chọn folder

Khi mở, tool hiện màn hình chọn thư mục chứa các project. Bạn có thể:
- bấm **Chọn bằng Finder…** (macOS),
- duyệt thư mục ngay trên trang (các thư mục có `pom.xml` được gắn tag `maven`; double-click để mở luôn),
- nhập đường dẫn rồi Enter,
- hoặc chọn lại một folder trong danh sách **Gần đây**.

Tool scan mọi thư mục con có `pom.xml`. Nếu bản thân folder đã chọn cũng là project Maven thì nó được thêm vào với tên `<tên> (root)`. Dùng nút **📂 Đổi folder** trên header để chuyển sang folder khác.

## Tính năng

- Mỗi module hiện artifact, version, phiên bản Java, branch git, số file chưa commit, số commit ahead/behind.
- Chọn nhiều module rồi build với `clean install`, `clean package`, … hoặc goal tuỳ chỉnh. Có tuỳ chọn `-DskipTests`, `-o`, `-U`, profile và args thêm.
- Tự chọn JDK theo `java.version` trong pom (macOS, qua `java_home`), hoặc chọn tay.
- Build song song (∥). Thứ tự build tự tuân theo dependency nội bộ (khớp theo artifactId). Nếu một module lỗi, các module phụ thuộc vào nó sẽ bị bỏ qua.
- Dùng `./mvnw` nếu wrapper đầy đủ, ngược lại dùng `mvn`.
- Log realtime, tô màu lỗi/cảnh báo, có ô lọc và chế độ "Chỉ lỗi".
- Preset nhóm module (lưu riêng theo từng folder). Có nút dừng build, thông báo desktop khi build xong, mở module trong Finder hoặc IntelliJ.

## Dữ liệu

Mọi thứ nằm trong `~/.mvn-dashboard/`:
- `state.json`: folder gần đây, tuỳ chọn build, lịch sử build và preset theo từng folder
- `logs/<folder>-<hash>/<module>.log`: log build gần nhất của từng module
