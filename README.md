# Solva

Ký quỹ tiền trả trước cho gói dịch vụ dài hạn, chạy trên Solana.

Tiền khách trả trước cho gói tập 12 tháng không chuyển vào ví của phòng tập. Tiền nằm trong một vault do chương trình Solana giữ và chảy sang phòng tập theo từng mốc dịch vụ. Nếu phòng tập ngừng phục vụ, chính khách lấy lại phần chưa dùng mà không cần ai cho phép, kể cả Solva.

Repo này gồm chương trình Anchor, bộ test toàn luồng và một web app demo kết nối ví Phantom. Mọi thao tác trên web app là giao dịch thật trên Solana Devnet, có mã hash tra được trên Solana Explorer. Tiền dùng trong demo là USDC thử nghiệm, không có giá trị thật.

## Mục lục

1. [Cấu trúc repo](#cấu-trúc-repo)
2. [Chương trình on-chain](#chương-trình-on-chain)
3. [Cài đặt](#cài-đặt)
4. [Build, test và deploy](#build-test-và-deploy)
5. [Chạy web app](#chạy-web-app)
6. [Hướng dẫn sử dụng](#hướng-dẫn-sử-dụng)
7. [Kịch bản demo 6 bước](#kịch-bản-demo-6-bước)
8. [Mã lỗi](#mã-lỗi)
9. [Xử lý sự cố](#xử-lý-sự-cố)
10. [Giới hạn của bản demo](#giới-hạn-của-bản-demo)

## Cấu trúc repo

| Đường dẫn | Nội dung |
| --- | --- |
| `programs/solva/src/lib.rs` | Chương trình Anchor: 6 lệnh, vault giữ SPL token |
| `native-tests/` | Test chạy toàn bộ kịch bản demo trên ngân hàng Solana cục bộ, không cần validator. Workspace riêng để không ảnh hưởng `anchor build` |
| `app/` | Web app React + Vite, kết nối Phantom |
| `app/scripts/setup.mjs` | Tạo USDC thử nghiệm và ví nhận phí, ghi `app/src/config.json` |
| `app/scripts/check-codec.ts` | Kiểm tra bộ mã hóa của frontend khớp với dữ liệu thật của chương trình |
| `Cargo.lock` | Đã khóa ở các phiên bản đọc được bằng Cargo 1.84 (bộ công cụ build của Solana CLI 2.2) |

## Chương trình on-chain

Chương trình có đúng 6 lệnh. Không lệnh nào cần chữ ký của Solva. Không có khóa quản trị, không có lệnh sửa điều khoản, đóng băng hay chuyển tiền về Solva.

| Lệnh | Ai phải ký | Làm gì |
| --- | --- | --- |
| `create_escrow` | Khách + cơ sở | Khóa điều khoản (giá trị, số mốc, độ dài mỗi mốc, % trả trước, phí, ngưỡng ngừng phục vụ), tạo vault rỗng. Tạo tài khoản cơ sở ở hợp đồng đầu tiên |
| `deposit` | Khách | Chuyển USDC từ ví khách vào vault, mở phần trả trước (20%) cho cơ sở |
| `record_checkin` | Khách + cơ sở | Ghi một lượt check-in, là bằng chứng cơ sở còn phục vụ. Thiếu một chữ ký thì bị từ chối |
| `confirm_milestone` | Bất kỳ ai | Mở phần tiền của một mốc khi đã tới hạn và trong kỳ có đủ lượt check-in |
| `trigger_termination` | Bất kỳ ai | Kết thúc hợp đồng khi dữ liệu chứng minh lý do. Khi cơ sở không có check-in nào trong cửa sổ quy định, cờ "ngừng phục vụ" bật một chiều và áp cho mọi hợp đồng của cơ sở |
| `withdraw` | Chủ của phần tiền | Cơ sở rút phần đã giải ngân (trừ phí 0,75% về ví phí của Solva). Khách rút phần chưa giải ngân sau khi hợp đồng kết thúc. Người khác bị từ chối |

Tài khoản trên chuỗi:

- `Facility` (PDA `["facility", ví cơ sở]`): số hợp đồng đang chạy, tổng lượt check-in, thời điểm check-in gần nhất, cờ ngừng phục vụ.
- `Escrow` (PDA `["escrow", ví khách, ví cơ sở, nonce]`): điều khoản đã khóa và trạng thái giải ngân.
- Vault (PDA `["vault", escrow]`): token account do PDA của hợp đồng sở hữu, giữ USDC của khách.

## Cài đặt

Hướng dẫn dưới đây dùng Windows: phần Rust/Solana/Anchor chạy trong **WSL (Ubuntu)**, phần web app chạy trong **CMD** hoặc WSL đều được.

### Trong WSL

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Solana CLI (Agave) 2.2
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
solana --version

# Anchor CLI 0.31.1
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 0.31.1
avm use 0.31.1
anchor --version

# Ví dùng để deploy (giữ kỹ file ~/.config/solana/id.json)
solana-keygen new
solana config set --url devnet
```

### Trên Windows

- Node.js 20 trở lên
- Chrome và extension **Phantom** (cài từ phantom.com hoặc Chrome Web Store, nhà phát triển là phantom.com)

### Thiết lập Phantom cho Devnet

1. Mở Phantom, chọn **Create a new wallet**, đặt mật khẩu, chép lại 12 từ khôi phục.
2. Bấm biểu tượng tài khoản ở góc trên bên trái → **Settings** → **Developer Settings**, bật **Testnet Mode**, chọn **Solana Devnet**.
3. Bấm vào tên tài khoản để copy địa chỉ ví.

## Build, test và deploy

Chạy trong WSL, tại thư mục gốc của repo. Build nhanh hơn nhiều nếu repo nằm trong thư mục nhà của Linux (ví dụ `~/DEMO`) thay vì `/mnt/c/...`.

### Test (không cần mạng, không cần validator)

```bash
cd native-tests
cargo test -- --nocapture
cd ..
```

Kết quả mong đợi:

```
1. mua gói: vault = 384615384 , mở trước cho cơ sở = 76923076
2. check-in hai chữ ký: thành công
3. check-in thiếu chữ ký khách: bị từ chối (3010 AccountNotSigner)
4. mốc 1 xác nhận; cơ sở rút 101794871 , phí Solva 769230
5. Solva rút: 6008 NotOwner; cơ sở rút quá: 6009; khách rút sớm: 6012; lệnh đóng băng: 101
6. cơ sở ngừng phục vụ; khách lấy lại 282051283 (= 7333333 đ)
test result: ok. 2 passed
```

### Deploy lên Devnet

```bash
solana airdrop 2              # hoặc https://faucet.solana.com; cần khoảng 3–4 SOL
anchor build                  # lần đầu: tạo khóa chương trình trong target/deploy/
anchor keys sync              # ghi địa chỉ chương trình vào lib.rs và Anchor.toml
anchor build                  # build lại với đúng địa chỉ
anchor deploy --provider.cluster devnet
cp target/deploy/solva-keypair.json ~/solva-keypair-backup.json
```

Kiểm tra trước khi deploy: `anchor keys list` và `grep declare_id programs/solva/src/lib.rs` phải ra cùng một địa chỉ. Nếu lệch, chương trình sẽ từ chối mọi lệnh với lỗi `DeclaredProgramIdMismatch (4100)`.

Deploy lại sau khi sửa code là nâng cấp tại chỗ, địa chỉ chương trình giữ nguyên.

## Chạy web app

### Lần đầu

```bash
cd app
npm install
npm run setup:devnet
```

`setup:devnet` dùng ví deploy để tạo USDC thử nghiệm và ví nhận phí 0,75% của Solva, rồi ghi `app/src/config.json`. Ví deploy cần ít nhất 0,05 SOL. Chỉ chạy lệnh này **một lần**: mỗi lần chạy lại sẽ tạo một loại USDC thử nghiệm mới và các quầy cũ không dùng được nữa.

Chuyển SOL devnet cho ví Phantom (khoảng 0,3 SOL):

```bash
solana transfer <ĐỊA_CHỈ_VÍ_PHANTOM> 0.3 --allow-unfunded-recipient --url devnet
```

### Mỗi lần mở máy

```bash
cd app
npm run dev
```

Mở `http://localhost:5173` trên Chrome, mở khóa Phantom, bấm nút ví ở góc phải → Phantom → Connect.

Nếu RPC công cộng của devnet hay báo lỗi `429`, đăng ký một RPC devnet miễn phí (ví dụ Helius) và thay dòng `"rpc"` trong `app/src/config.json`. Không cần deploy hay setup lại.

## Hướng dẫn sử dụng

### Màn hình

Trên cùng là địa chỉ chương trình (bấm để mở Explorer), nút ví, khung **Chuẩn bị quầy** và thanh **6 bước** kèm dòng *Lời dẫn* để đọc to khi trình bày. Bên dưới là bốn khung:

| Khung | Đóng vai | Ai ký giao dịch |
| --- | --- | --- |
| Ứng dụng của khách | Người mua gói tập | Ví Phantom, có cửa sổ duyệt |
| Quầy · Phòng tập An Khang | Chủ phòng tập | Ví quầy trong trình duyệt, tự ký |
| Quản trị Solva | Đơn vị vận hành | Ví Solva trong trình duyệt, tự ký |
| Sổ giao dịch | Bằng chứng trên chuỗi | Mỗi dòng là một giao dịch, có trạng thái, chữ ký, link Explorer và nhật ký chương trình |

Thời gian được nén để trình diễn: **1 tháng = 60 giây**, **7 ngày không có check-in = 120 giây**. Đây là tham số khóa trong từng hợp đồng; bản thật dùng 30 ngày và 7 ngày.

### Các ví

| Ví | Nằm ở đâu | SOL | Vai trò |
| --- | --- | --- | --- |
| Phantom | Extension | 0,3 trở lên | Khách; trả phí cho mọi thao tác của khách và nạp phí cho các ví bên dưới |
| Ví quầy | Bộ nhớ trình duyệt | 0,05, nạp khi Chuẩn bị quầy | Ký phía cơ sở khi check-in và khi rút tiền |
| Ví Solva | Bộ nhớ trình duyệt | 0,02 | Gọi xác nhận mốc; không có quyền gì với tiền trong vault |
| Hai hội viên mẫu | Bộ nhớ trình duyệt | 0,03 mỗi người | Tự check-in khoảng 30 giây một lần khi phòng tập mở cửa |
| Ví deploy | WSL, `~/.config/solana/id.json` | Khi cần | Deploy, nâng cấp chương trình, chạy setup |

Ví quầy và ví Solva hiện 0 SOL ở một lượt demo mới là bình thường. Không xóa dữ liệu duyệt web của localhost vì khóa của các ví này nằm trong đó.

### Chuẩn bị một lượt demo

1. Bấm **Chuẩn bị quầy**, duyệt một lần trên Phantom (chuyển khoảng 0,13 SOL phí mạng).
2. App tự gửi thêm 3 giao dịch: cấp USDC thử nghiệm, rồi hai hội viên mua gói. Chờ thông báo **"Quầy đã sẵn sàng"**.
3. Khung Quầy phải hiện "Hợp đồng đang chạy: 2".
4. Nếu báo "Chưa xong bước chuẩn bị", bấm **Chuẩn bị quầy** lần nữa. App chạy tiếp từ chỗ dở, không nạp phí lại.

Muốn làm một lượt sạch: bấm **Tạo quầy mới cho lượt demo khác** ở cuối khung Solva, rồi **Chuẩn bị quầy**. Mỗi lượt tốn khoảng 0,14 SOL của Phantom.

### Từng nút làm gì

**Khung khách**

| Nút | Lệnh | Ai ký | Kết quả |
| --- | --- | --- | --- |
| Thanh toán và ký hợp đồng | `create_escrow` + `deposit` | Khách + quầy | 10.000.000 đ (384,62 USDC) vào vault; 20% mở ngay cho phòng tập |
| Check-in | `record_checkin` | Khách + quầy | Ghi một lượt đến tập. Xám khi phòng tập đóng cửa hoặc hợp đồng đã kết thúc |
| Lấy lại tiền | `trigger_termination` + `withdraw` | Chỉ khách | Nếu phòng tập đã 120 giây không có check-in: kết thúc hợp đồng và chuyển phần chưa giải ngân về ví khách. Bấm sớm bị `6007` |

**Khung Quầy**

| Nút | Lệnh | Ai ký | Kết quả |
| --- | --- | --- | --- |
| Rút phần đã giải ngân | `withdraw` | Quầy | Nhận phần đã mở, trừ 0,75% phí về ví phí của Solva |
| Đóng cửa phòng tập / Mở cửa lại | Không phải giao dịch | | Dừng hoặc tiếp tục check-in tự động của hai hội viên, khóa nút Check-in của khách. Cờ "ngừng phục vụ" trên chuỗi là một chiều: mở cửa lại sau khi cờ đã bật không có tác dụng |
| Tự ghi check-in, không cần khách | `record_checkin` thiếu chữ ký khách | Quầy | Thử gian lận, luôn bị từ chối `3010` |
| Rút toàn bộ tiền trong vault | `withdraw` với số tiền bằng cả vault | Quầy | Thử gian lận, luôn bị từ chối `6009` |

**Khung Solva**

| Nút | Lệnh | Ai ký | Kết quả |
| --- | --- | --- | --- |
| Xác nhận mốc tháng | `confirm_milestone` | Ví Solva chỉ trả phí mạng | Mở thêm 1/12 phần còn lại (666.667 đ) khi đã qua 60 giây và trong kỳ có ít nhất một lượt check-in |
| Rút toàn bộ vault về ví Solva | `withdraw` | Solva | Luôn bị từ chối `6008` |
| Đóng băng hợp đồng của khách | `freeze_escrow` (không tồn tại) | Solva | Luôn bị từ chối `101`: chương trình không có nút dừng |
| Tạo quầy mới cho lượt demo khác | Không phải giao dịch | | Tạo khóa mới cho quầy, Solva, hai hội viên; xóa sổ giao dịch trên màn hình |

**Dịch vụ nền.** Khi vận hành thật, Solva chạy một chương trình nhỏ định kỳ gọi `confirm_milestone` cho mọi hợp đồng đến hạn, để cơ sở nhận tiền đều mà không phải tự bấm. Lệnh này ai gọi cũng được và không chạm vào tiền ngoài việc mở đúng phần đã khóa trong điều khoản; Solva ngừng chạy thì bất kỳ ai cũng thay được. Trong demo, đó là nút **Xác nhận mốc tháng**.

**Các ô số liệu.** "Tiền của bạn đang được giữ trong vault" là phần khách nhận lại nếu phòng tập đóng cửa ngay lúc đó. "Của khách này, rút được" là phần đã mở mà quầy chưa rút. "Ngưỡng ngừng phục vụ còn …s" là thời gian còn lại trước khi khách được quyền lấy lại tiền nếu không có thêm check-in. "Phí 0,75% đã thu" là doanh thu của Solva.

## Kịch bản demo 6 bước

Bấm theo thứ tự trên thanh 6 bước hoặc bằng nút trong từng khung. Tổng khoảng 5–6 phút, có hai lần chờ: 60 giây trước bước 4 và tối đa 120 giây ở bước 6.

| Bước | Bấm gì | Phantom | Kết quả đúng |
| --- | --- | --- | --- |
| 1. Khách mua gói | "Thanh toán và ký hợp đồng" | Có | 8.000.000 đ đang giữ trong vault; đồng hồ 60 giây của mốc tháng 1 bắt đầu |
| 2. Check-in chữ ký kép | "Check-in" | Có | Thành công, hai chữ ký (khách, quầy). Mở Explorer cho giám khảo xem |
| 3. Quầy tự khai | "Tự ghi check-in, không cần khách" | Không | Bị từ chối `AccountNotSigner (3010)`, giao dịch vẫn nằm trên Explorer |
| 4. Qua một kỳ | Khi khung khách hiện "Mốc tháng tiếp theo: đã tới hạn", bấm bước 4 | Không | Xác nhận mốc và quầy rút phần của mình; khung Solva hiện phí đã thu |
| 5. Thử rút tiền khách | Bước 5, hoặc hai nút "Rút toàn bộ…" | Không | Cả hai bị từ chối: `NotOwner (6008)`, `ExceedsReleased (6009)` |
| 6. Phòng tập đóng cửa | "Đóng cửa phòng tập", chờ đếm ngược về 0, bấm "Lấy lại tiền" | Có | 7.333.333 đ về ví khách; giao dịch chỉ có chữ ký của khách |

Mẹo: dùng bước 2 và 3 để lấp 60 giây chờ. Muốn rút ngắn bước 6, bấm "Đóng cửa phòng tập" ngay sau bước 4 rồi làm bước 5 trong lúc đếm ngược. Ở bước 3, 5 và 6, mời giám khảo tự tay bấm. Nên quay sẵn một video đủ 6 bước để dự phòng sự cố mạng.

## Mã lỗi

Giao dịch bị từ chối vẫn được gửi lên chuỗi (`skipPreflight`), nên Explorer hiển thị đúng mã lỗi của chương trình.

| Mã | Tên | Nghĩa | Khi nào gặp |
| --- | --- | --- | --- |
| 3010 | AccountNotSigner | Thiếu chữ ký bắt buộc | Bước 3 (đúng kịch bản) |
| 6008 | NotOwner | Người ký không sở hữu phần tiền nào trong vault | Bước 5, Solva rút |
| 6009 | ExceedsReleased | Vượt phần được phép rút | Bước 5, quầy rút toàn bộ |
| 101 | InstructionFallbackNotFound | Lệnh không tồn tại | Nút "Đóng băng hợp đồng" |
| 6007 | FacilityStillServing | Chưa đủ 120 giây không có check-in | Bấm "Lấy lại tiền" quá sớm |
| 6012 | EscrowActive | Hợp đồng còn chạy, phần của khách chưa mở | Khách rút khi chưa kết thúc |
| 6004 | MilestoneNotDue | Mốc chưa tới hạn | Bấm bước 4 trước 60 giây |
| 6005 | NotEnoughEvidence | Trong kỳ chưa có lượt check-in | Chờ hội viên check-in (30 giây) rồi bấm lại |
| 6002 | FacilityClosed | Cơ sở đã bị xác định ngừng phục vụ | Sau bước 6; tạo quầy mới để làm lượt khác |
| 4100 | DeclaredProgramIdMismatch | Địa chỉ trong `lib.rs` khác địa chỉ đã deploy | Xem mục Xử lý sự cố |

## Xử lý sự cố

| Hiện tượng | Nguyên nhân | Cách xử lý |
| --- | --- | --- |
| `edition2024` khi `anchor build` | `Cargo.lock` bị cập nhật lên crate mới | Lấy lại `Cargo.lock` của repo; không chạy `cargo update` ở thư mục gốc |
| `DeclaredProgramIdMismatch (4100)` | Khóa chương trình bị tạo lại (thường sau `cargo clean`) mà chưa sync | `anchor keys sync`, `anchor build`, `anchor deploy --provider.cluster devnet` |
| Trang trắng khi `npm run dev` | Thiếu `app/src/polyfills.ts` | Lấy lại file từ repo, F5 |
| Trang báo "Chưa có cấu hình" | Chưa chạy hoặc chạy hỏng `setup:devnet` | Nạp SOL cho ví deploy, chạy lại `npm run setup:devnet` |
| Nút ví "Connecting…" mãi | Phantom đang khóa | Mở khóa Phantom, F5. Vẫn treo: xóa localhost trong Phantom → Connected Apps, kết nối lại |
| Lỗi `429` / "Connection rate limits exceeded" | RPC công cộng nghẽn | Chờ rồi bấm lại; ổn định hơn thì dùng RPC riêng (sửa `"rpc"` trong `config.json`) |
| Giao dịch "Đang gửi" lâu | Mạng chậm | Chờ tối đa 75 giây, không bấm lặp; mở link Explorer để kiểm tra |
| Phantom báo không đủ SOL | Ví dưới 0,15 SOL | `solana transfer` từ ví deploy |

Không chạy `cargo clean` trước giờ demo: lệnh này xóa `target/deploy/solva-keypair.json`. Nếu lỡ xóa, chép lại từ bản sao `~/solva-keypair-backup.json`.

## Giới hạn của bản demo

- Khóa của quầy, ví Solva và hai hội viên mẫu nằm trong bộ nhớ trình duyệt; khóa đúc USDC thử nghiệm nằm trong `app/src/config.json`. Chỉ dùng trên devnet hoặc localnet.
- Quy tắc ngừng phục vụ trong bản này là "không có lượt check-in nào trong cửa sổ". Điều kiện "trên 20% khách cùng báo đóng cửa" chưa được cài.
- USDC là token thử nghiệm 6 chữ số thập phân; tỷ giá 26.000 đ/USDC chỉ để hiển thị.
- Chương trình chưa qua kiểm toán độc lập.