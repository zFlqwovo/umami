'use client';
import { Column, Dialog, Modal, type ModalProps } from '@umami/react-zen';
import { ReplayPlayback } from '@/app/(main)/websites/[websiteId]/replays/[replayId]/ReplayPlayback';
import { useNavigation } from '@/components/hooks';
import { buildPath } from '@/lib/url';

export interface ReplayModalProps extends ModalProps {
  websiteId: string;
  replayId?: string;
}

export function ReplayModal({ websiteId, replayId, ...props }: ReplayModalProps) {
  const {
    router,
    query: { replay },
    searchParams,
    updateParams,
  } = useNavigation();
  const activeReplayId = replayId || replay;

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      if (replayId) {
        const query = Object.fromEntries(searchParams.entries());
        delete query.replay;

        router.push(buildPath(`/websites/${websiteId}/replays`, query));
      } else {
        router.push(updateParams({ replay: undefined }));
      }
    }
  };

  return (
    <Modal
      placement="bottom"
      offset="80px"
      isOpen={!!activeReplayId}
      onOpenChange={handleOpenChange}
      isDismissable
      {...props}
    >
      <Column height="100%" maxWidth="1320px" style={{ margin: '0 auto' }}>
        <Dialog variant="sheet">
          {({ close }) => (
            <Column padding="6">
              {activeReplayId && (
                <ReplayPlayback websiteId={websiteId} replayId={activeReplayId} onClose={close} />
              )}
            </Column>
          )}
        </Dialog>
      </Column>
    </Modal>
  );
}
