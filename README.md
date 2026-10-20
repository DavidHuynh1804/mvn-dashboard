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

- **Dạng cây:** project aggregator hiện các module Maven con bên dưới (đóng/mở bằng ▾). Module con là git submodule (ví dụ `common-entities`) có tag `submodule` và branch riêng.
- **Build độc lập:** 🔨 trên project build cả reactor; 🔨 trên module con chạy `./mvnw -pl <module>` từ thư mục project cha. Nếu chọn cả cha lẫn con thì chỉ build cha.
- **Run app:** ▶ chạy app (mặc định `./mvnw -pl <module app> spring-boot:run`), ■ để dừng. Lệnh run sửa được ở tab **App** và được lưu riêng theo từng module. Tool tự nhận biết khi app khởi động xong và hiện port kèm link. Khi app của project đang chạy thì không build được project đó (vì `clean` sẽ xoá `target`).
- **Terminal:** tab **Terminal** (hoặc nút ⌨) mở shell tương tác thật tại thư mục module, kèm `JAVA_HOME` đúng phiên bản. Mỗi module có một phiên riêng, giữ nguyên khi chuyển qua lại. Cần `python3` (có sẵn trên macOS) và Internet ở lần đầu để tải xterm.js.

- Mỗi module hiện artifact, version, phiên bản Java, branch git, số file chưa commit, số commit ahead/behind.
- Chọn nhiều module rồi build với `clean install`, `clean package`, … hoặc goal tuỳ chỉnh. Có tuỳ chọn `-DskipTests`, `-o`, `-U`, profile và args thêm.
- Tự chọn JDK theo `java.version` trong pom (macOS, qua `java_home`), hoặc chọn tay.
- Build song song (∥). Thứ tự build tự tuân theo dependency nội bộ (khớp theo artifactId). Nếu một module lỗi, các module phụ thuộc vào nó sẽ bị bỏ qua.
- Dùng `./mvnw` nếu wrapper đầy đủ, ngược lại dùng `mvn`.
- **Đổi branch:** bấm vào tag branch của module (`⎇ main ▾`) để mở danh sách branch local và remote, có ô tìm kiếm, bấm để checkout (branch remote sẽ được tạo local tracking). Có nút Fetch, Pull (`--ff-only`) và cập nhật submodule.
- **Ô lệnh** dưới khung log: gõ lệnh, lệnh chạy trong thư mục của module đang xem, với `JAVA_HOME` đúng phiên bản. Dùng ↑/↓ để xem lại lịch sử lệnh, nút ■ để dừng, gõ `clear` để xoá log. Ô này không dành cho lệnh tương tác (lệnh cần nhập liệu sẽ nhận EOF).
- Log realtime, tô màu lỗi/cảnh báo, có ô lọc và chế độ "Chỉ lỗi". Nút 🗑 Clear xoá log của module đang xem; Shift+click để xoá log tất cả module.
- Preset nhóm module (lưu riêng theo từng folder). Có nút dừng build và thông báo desktop khi build xong.
- **Mở bằng:** nút ↗ mở thư mục module bằng app mặc định (mặc định là VS Code). Menu ▾ cho chọn app khác (IntelliJ, Cursor, Zed, Terminal, iTerm, Warp, Fork, Finder, …). Tool chỉ hiện những app đã cài. Bấm ☆ để đặt mặc định; "+ Thêm app khác…" để thêm app bất kỳ trong Applications.

## Dữ liệu

Mọi thứ nằm trong `~/.mvn-dashboard/`:
- `state.json`: folder gần đây, tuỳ chọn build, lịch sử build và preset theo từng folder
- `logs/<folder>-<hash>/<module>.log`: log build gần nhất của từng module

## Phát triển tool

```bash
npm run dev
```

- Sửa `index.html` thì trình duyệt tự tải lại ngay.
- Sửa `server.js` thì `node --watch` tự khởi động lại server, trang tự tải lại khi kết nối lại.
- Ở chế độ dev, server tự mở lại folder dùng gần nhất, và trang nhớ module đang xem. Trình duyệt chỉ mở ở lần chạy đầu.
- Lưu ý: khởi động lại server sẽ dừng các build hoặc lệnh đang chạy.
