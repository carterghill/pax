#import <AppKit/AppKit.h>
#include <stdbool.h>

// AppKit draws the card in the current appearance, including when the user
// switches between light and dark mode while a banner is on screen.
@interface PaxMessageCard : NSView
@end

@implementation PaxMessageCard
- (void)drawRect:(NSRect)dirtyRect {
    BOOL dark = NO;
    if (@available(macOS 10.14, *)) {
        dark = [[self.effectiveAppearance bestMatchFromAppearancesWithNames:
            @[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]] isEqualToString:NSAppearanceNameDarkAqua];
    }
    NSColor *leading = dark ? [NSColor colorWithSRGBRed:0.19 green:0.17 blue:0.25 alpha:1]
                            : [NSColor colorWithSRGBRed:0.94 green:0.92 blue:0.99 alpha:1];
    NSColor *trailing = dark ? [NSColor colorWithSRGBRed:0.14 green:0.14 blue:0.17 alpha:1]
                             : [NSColor colorWithSRGBRed:0.99 green:0.99 blue:1 alpha:1];
    NSBezierPath *shape = [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds, 0.5, 0.5)
                                                          xRadius:18 yRadius:18];
    [[[NSGradient alloc] initWithStartingColor:leading endingColor:trailing] drawInBezierPath:shape angle:0];
    [[NSColor.labelColor colorWithAlphaComponent:0.12] setStroke];
    [shape stroke];
}
@end

// A tauri dev executable has no application bundle to register with Notification Center.
static NSMutableArray<NSPanel *> *banners;

static void layoutBanners(void) {
    NSScreen *screen = NSApp.mainWindow.screen ?: NSScreen.mainScreen;
    NSRect area = screen.visibleFrame;
    CGFloat y = NSMaxY(area) - 12;
    for (NSPanel *panel in banners.reverseObjectEnumerator) {
        [panel setFrameTopLeftPoint:NSMakePoint(NSMaxX(area) - NSWidth(panel.frame) - 12, y)];
        y -= NSHeight(panel.frame) + 8;
    }
}

bool pax_show_unbundled_message(const char *title, const char *body, const uint8_t *iconPNG, size_t iconLength) {
    if ([NSBundle.mainBundle.bundleURL.pathExtension.lowercaseString isEqualToString:@"app"]) return false;
    NSString *heading = @(title);
    NSString *preview = @(body);
    // Rust passes an embedded, process-lifetime PNG. Decode it once on the UI thread.
    dispatch_async(dispatch_get_main_queue(), ^{
        static NSImage *paxIcon;
        if (!paxIcon) paxIcon = [[NSImage alloc] initWithData:[NSData dataWithBytes:iconPNG length:iconLength]];

        const CGFloat width = 360, inset = 16, iconSize = 44, gap = 12;
        const CGFloat textWidth = width - 2 * inset - iconSize - gap;
        NSPanel *panel = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, width, 90)
            styleMask:NSWindowStyleMaskNonactivatingPanel | NSWindowStyleMaskBorderless
            backing:NSBackingStoreBuffered defer:NO];
        panel.title = @"Pax message";
        panel.opaque = NO;
        panel.backgroundColor = NSColor.clearColor;
        panel.hasShadow = YES;
        panel.level = NSStatusWindowLevel;
        panel.hidesOnDeactivate = NO;
        panel.ignoresMouseEvents = YES;
        panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
            NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorIgnoresCycle;

        PaxMessageCard *card = [[PaxMessageCard alloc] initWithFrame:panel.contentView.bounds];
        panel.contentView = card;
        NSImageView *icon = [NSImageView imageViewWithImage:paxIcon];
        icon.imageScaling = NSImageScaleProportionallyUpOrDown;
        [icon setAccessibilityElement:NO];
        NSTextField *source = [NSTextField labelWithString:@"Pax"];
        source.font = [NSFont systemFontOfSize:11 weight:NSFontWeightSemibold];
        source.textColor = NSColor.secondaryLabelColor;
        NSTextField *name = [NSTextField labelWithString:heading];
        name.font = [NSFont systemFontOfSize:14 weight:NSFontWeightSemibold];
        name.lineBreakMode = NSLineBreakByTruncatingTail;
        name.maximumNumberOfLines = 1;
        NSTextField *text = [NSTextField wrappingLabelWithString:preview];
        text.font = [NSFont systemFontOfSize:13];
        text.textColor = NSColor.secondaryLabelColor;
        text.maximumNumberOfLines = 2;
        text.lineBreakMode = NSLineBreakByWordWrapping;
        text.cell.truncatesLastVisibleLine = YES;
        text.preferredMaxLayoutWidth = textWidth;

        for (NSView *view in @[icon, source, name, text]) {
            view.translatesAutoresizingMaskIntoConstraints = NO;
            [card addSubview:view];
        }
        [NSLayoutConstraint activateConstraints:@[
            [icon.leadingAnchor constraintEqualToAnchor:card.leadingAnchor constant:inset],
            [icon.centerYAnchor constraintEqualToAnchor:card.centerYAnchor],
            [icon.widthAnchor constraintEqualToConstant:iconSize],
            [icon.heightAnchor constraintEqualToConstant:iconSize],
            [source.leadingAnchor constraintEqualToAnchor:icon.trailingAnchor constant:gap],
            [source.topAnchor constraintEqualToAnchor:card.topAnchor constant:12],
            [name.leadingAnchor constraintEqualToAnchor:source.leadingAnchor],
            [name.trailingAnchor constraintEqualToAnchor:card.trailingAnchor constant:-inset],
            [name.topAnchor constraintEqualToAnchor:source.bottomAnchor constant:3],
            [text.leadingAnchor constraintEqualToAnchor:source.leadingAnchor],
            [text.widthAnchor constraintEqualToConstant:textWidth],
            [text.topAnchor constraintEqualToAnchor:name.bottomAnchor constant:2],
        ]];
        [card layoutSubtreeIfNeeded];
        [panel setContentSize:NSMakeSize(width, ceil(NSMaxY(card.bounds) - NSMinY(text.frame)) + 12)];

        if (!banners) banners = [[NSMutableArray alloc] init];
        if (banners.count >= 3) {
            [banners.firstObject orderOut:nil];
            [banners removeObjectAtIndex:0];
        }
        [banners addObject:panel];
        layoutBanners();
        [panel orderFrontRegardless];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            [panel orderOut:nil];
            [banners removeObject:panel];
            layoutBanners();
        });
    });
    return true;
}
